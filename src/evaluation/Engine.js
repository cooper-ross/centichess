const engines = {
    'stockfish-17-lite': {
        name: "Stockfish 17 Lite",
        path: "./src/engines/stockfish/stockfish-17-lite.js",
    },
    'stockfish-16-nnue': {
        name: "Stockfish 16 NNUE",
        path: "./src/engines/stockfish/stockfish-nnue-16.js",
    },
    'stockfish-16-lite': {
        name: "Stockfish 16 Lite",
        path: "./src/engines/stockfish/fallback-stockfish.js",
    },
    'stockfish-11': {
        name: "Stockfish 11",
        path: "./src/engines/stockfish/stockfish-11.js",
    }
}


export class Engine {
    currentDepth = 0;
    multiPV = 3;
    busy = false;
    currentResolve = null;
    currentReject = null;

    constructor({ engineType = 'stockfish-17-lite' } = {}) {
        this.engine = engines[engineType];
        this.worker = new Worker(this.engine.path);
        
        this.worker.postMessage("uci");
        this.worker.postMessage(`setoption name MultiPV value ${this.multiPV}`);
        
        // Setup global message handler for reuse
        this.worker.addEventListener("error", this.handleError.bind(this));
        
        // Add onerror handler directly (catches more errors than the event listener)
        this.worker.onerror = this.handleError.bind(this);
        
        // Add global error handling through window for worker errors
        window.addEventListener('unhandledrejection', (event) => {
            if (event.reason && event.reason.toString().includes('stockfish')) {
                console.log("Caught unhandled rejection:", event.reason);
                this.handleError(event.reason);
                event.preventDefault();
            }
        });
    }
    
    // Method to abort current evaluation
    abort() {
        this.worker.postMessage('stop');
        if (this.currentResolve) {
            this.currentResolve([]);
            this.currentResolve = null;
            this.currentReject = null;
        }
        this.busy = false;
    }
    
    // Properly terminate worker
    terminate() {
        this.abort();
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }
    
    handleError(err) {
        console.log("Engine error", err);
        if (this.currentReject) {
            this.currentReject(err);
            this.currentResolve = null;
            this.currentReject = null;
        }
        
        // Fallback to alternative engine if needed
        this.fallbackToAlternativeEngine();
        
        return true; // Prevent the error from propagating
    }
    
    fallbackToAlternativeEngine(fallen = 0) {
        if (fallen > 1) return;
        
        if (this.worker) {
            try {
                this.worker.terminate();
            } catch (err) {
                console.log("Error terminating worker:", err);
            }
        }
        
        try {
            console.log("Falling back to alternative engine");
            this.engine = engines['stockfish-16-lite'];
            this.worker = new Worker(this.engine.path);

            this.worker.postMessage("uci");
            this.worker.postMessage(`setoption name MultiPV value ${this.multiPV}`);
            this.worker.addEventListener("error", this.handleError.bind(this));
            this.worker.onerror = this.handleError.bind(this);
        } catch (err) {
            console.log("Error creating fallback worker:", err);
            
            // Try with a different engine if the fallback fails
            if (fallen < 1) {
                console.log("Trying with most basic engine");
                this.engine = engines['stockfish-11'];
                try {
                    this.worker = new Worker(this.engine.path);
                    this.worker.postMessage("uci");
                    this.worker.postMessage(`setoption name MultiPV value ${this.multiPV}`);
                    this.worker.addEventListener("error", this.handleError.bind(this));
                    this.worker.onerror = this.handleError.bind(this);
                } catch (e) {
                    console.log("All engine attempts failed");
                    this.worker = null;
                }
            } else {
                this.worker = null;
            }
        }
    }

    interpret(uciOutputLines, fen, targetDepth) {
        const lines = [];
        const outputs = uciOutputLines.filter(uciOutput => uciOutput.startsWith("info depth"));
        for (const output of outputs) {
            // Extract depth, MultiPV line ID and evaluation from search message
            const id = parseInt(output.match(/(?:multipv )(\d+)/)?.[1]);
            const depth = parseInt(output.match(/(?:depth )(\d+)/)?.[1]);
            const uciMove = output.match(/(?: pv )(.+?)(?= |$)/)?.[1];
            
            if (!id || !depth || !uciMove || depth != targetDepth || lines.some(line => line.id == id)) continue;

            // Invert score for black since stockfish is negamax instead of minimax
            const negamaxScore = parseInt(output.match(/(?:(?:cp )|(?:mate ))([\d-]+)/)?.[1] || "0");
            const score = fen.includes(" b ") ? -negamaxScore : negamaxScore;
            const type = output.includes(" cp ") ? "cp" : "mate";
            const pv = output.match(/.*pv\s+(.*)$/)?.[1].split(" ")

            lines.push({ id, uciMove, depth, score, type, pv });
        }

        return lines;
    }

    async evaluate(fen, targetDepth, verbose = false, progressCallback = null, fallen = 0) {
        this.busy = true;
        
        // Reset current depth
        this.currentDepth = 0;
        
        if (!this.worker) {
            try {
                this.worker = new Worker(engines[0].path);
                this.worker.postMessage("uci");
                this.worker.postMessage(`setoption name MultiPV value ${this.multiPV}`);
                this.worker.addEventListener("error", this.handleError.bind(this));
                this.worker.onerror = this.handleError.bind(this);
            } catch (err) {
                console.log("Error creating worker:", err);
                this.fallbackToAlternativeEngine(fallen);
                return this.evaluate(fen, targetDepth, verbose, progressCallback, fallen + 1);
            }
        }
        
        try {
            this.worker.postMessage(`position fen ${fen}`);
            this.worker.postMessage(`go depth ${targetDepth}`);
        } catch (err) {
            console.log("Error sending commands to worker:", err);
            this.fallbackToAlternativeEngine(fallen);
            return this.evaluate(fen, targetDepth, verbose, progressCallback, fallen + 1);
        }

        const messages = [];

        return new Promise((resolve, reject) => {
            this.currentResolve = resolve;
            this.currentReject = reject;
            
            const messageHandler = (event) => {
                try {
                    const message = event.data;
                    messages.unshift(message);

                    if (verbose) console.log(message);

                    let latestDepth = parseInt(message.match(/(?:depth )(\d+)/)?.[1] || "0");
                    if (latestDepth > 0) {
                        this.currentDepth = Math.max(latestDepth, this.currentDepth);
                        
                        // Report progress based on current depth compared to target depth
                        if (progressCallback && typeof progressCallback === 'function') {
                            const progressPercent = Math.round((this.currentDepth / targetDepth) * 100);
                            progressCallback({
                                depth: this.currentDepth,
                                targetDepth: targetDepth,
                                percent: progressPercent
                            });
                        }
                    }

                    // Best move or checkmate log indicates end of search
                    if (message.startsWith("bestmove") || message.includes("depth 0")) {            
                        const lines = this.interpret(messages, fen, targetDepth);
                        
                        // Report 100% completion
                        if (progressCallback && typeof progressCallback === 'function') {
                            progressCallback({
                                depth: targetDepth,
                                targetDepth: targetDepth,
                                percent: 100
                            });
                        }
                        
                        this.worker.removeEventListener("message", messageHandler);
                        this.busy = false;
                        this.currentResolve = null;
                        this.currentReject = null;
                        resolve(lines);
                    }
                } catch (err) {
                    console.log("Error handling message:", err);
                    this.worker.removeEventListener("message", messageHandler);
                    this.handleError(err);
                }
            };

            this.worker.addEventListener("message", messageHandler, { once: false });
            
            // Add safety timeout in case engine gets stuck
            setTimeout(() => {
                if (this.busy && this.currentResolve === resolve) {
                    console.warn("Engine evaluation timed out, falling back");
                    this.worker.removeEventListener("message", messageHandler);
                    
                    if (fallen < 2) {
                        // Try with fallback engine
                        this.fallbackToAlternativeEngine(fallen);
                        this.evaluate(fen, targetDepth, verbose, progressCallback, fallen + 1)
                            .then(resolve)
                            .catch(reject);
                    } else {
                        // Give up after fallback attempt
                        this.busy = false;
                        this.currentResolve = null;
                        this.currentReject = null;
                        resolve([]);

                        console.log("Gave up")
                    }
                }
            }, 30000 * targetDepth); // timeout depends on depth
        });
    }
}