import http from 'node:http';
import { readAllChunks, tryParse } from '../../src/util.js';

export class MockServer {
    /** @type {string} */
    host;
    /** @type {number} */
    port;
    /** @type {import('http').Server} */
    server;

    /**
     * Replies queued by {@link script}, taken one per request, oldest first.
     * @type {string[]}
     */
    scriptedReplies = [];

    /**
     * Every request body this server has been sent, in order.
     *
     * The prompt is half of what an integration test needs to assert. "The memory was retrieved" is not a
     * claim about the reply — the model is a stub and its answer proves nothing — it is a claim about what
     * the fork PUT IN FRONT of the model, which is visible only here.
     * @type {object[]}
     */
    requests = [];

    /**
     * Creates an instance of MockServer.
     * @param {object} [param] Options object.
     * @param {string} [param.host] The hostname or IP address to bind the server to.
     * @param {number} [param.port] The port number to listen on.
     */
    constructor({ host, port } = {}) {
        this.host = host ?? '127.0.0.1';
        this.port = port ?? 3000;
    }

    /**
     * Queue replies to hand back, in order, one per request.
     *
     * ⚠️ WHY A QUEUE AND NOT A FIXED STRING. A memory test has to plant a fact on one turn and ask about it
     * on a later one, so the two turns must be able to differ — and it has to know WHICH turn it is looking
     * at. Echoing the prompt back, which is what this server does by default, cannot express either.
     *
     * 🔴 Falls back to the echo when the queue runs dry, deliberately: every existing suite relies on the
     * echo and none of them call this, so an empty queue must leave behaviour exactly as it was. A test that
     * queues too few replies gets the echo rather than a hang or a 500, which is also why
     * {@link repliesRemaining} exists — assert on it rather than inferring from a reply that looks wrong.
     * @param {string[]} replies The replies, in the order they should be handed out
     * @returns {this} This server, for chaining
     */
    script(replies) {
        if (!Array.isArray(replies) || replies.some(reply => typeof reply !== 'string')) {
            throw new TypeError('MockServer.script() takes an array of strings.');
        }

        this.scriptedReplies.push(...replies);
        return this;
    }

    /**
     * How many scripted replies have not been handed out yet.
     * @returns {number} The count
     */
    get repliesRemaining() {
        return this.scriptedReplies.length;
    }

    /**
     * Handles Chat Completions requests.
     * @param {object} jsonBody The parsed JSON body from the request.
     * @returns {object} Mock response object.
     */
    handleChatCompletions(jsonBody) {
        this.requests.push(jsonBody);

        const messages = jsonBody?.messages;
        const lastMessage = messages?.[messages.length - 1];

        // A scripted reply if one is waiting; otherwise the echo this server has always given.
        const content = this.scriptedReplies.length > 0
            ? this.scriptedReplies.shift()
            : String(lastMessage?.content ?? 'No prompt messages.');

        const mockResponse = {
            choices: [
                {
                    finish_reason: 'stop',
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content: `${jsonBody?.model}\n${messages?.length}\n${jsonBody?.max_tokens}`,
                        content,
                    },
                },
            ],
            created: 0,
            model: jsonBody?.model,
        };
        return mockResponse;
    }

    /**
     * Starts the mock server.
     * @returns {Promise<void>}
     */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    const body = await readAllChunks(req);
                    const jsonBody = tryParse(body.toString());
                    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
                        const mockResponse = this.handleChatCompletions(jsonBody);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(mockResponse));
                    } else {
                        res.writeHead(404);
                        res.end();
                    }
                } catch (error) {
                    res.writeHead(500);
                    res.end();
                }
            });

            this.server.on('error', (err) => {
                reject(err);
            });

            this.server.listen(this.port, this.host, () => {
                resolve();
            });
        });
    }

    /**
     * Stops the mock server.
     * @returns {Promise<void>}
     */
    async stop() {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                return reject(new Error('Server is not running.'));
            }
            this.server.closeAllConnections();
            this.server.close(( /** @type {NodeJS.ErrnoException|undefined} */ err) => {
                if (err && (err?.code !== 'ERR_SERVER_NOT_RUNNING')) {
                    return reject(err);
                }
                resolve();
            });
        });
    }
}
