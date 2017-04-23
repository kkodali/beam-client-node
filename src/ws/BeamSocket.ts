import { AuthenticationFailedError, BadMessageError, NoMethodHandlerError } from '../errors';
import { Reply } from './Reply';
import { EventEmitter } from 'events';
import * as NodeWebSocket from 'ws';

// The method of the authentication packet to store.
const authMethod = 'auth';

/**
 * A TimeoutError is thrown in call if we don't get a response from the
 * chat server within a certain interval.
 */
class TimeoutError extends Error {}

/**
 * Return a promise which is rejected with a TimeoutError after the
 * provided delay.
 * @param  {Number} delay
 * @return {Promise}
 */
function timeout (delay: number): Promise<void> {
    return new BeamSocket.Promise<void>((_resolve, reject) => {
        setTimeout(() => {
            reject(new TimeoutError());
        }, delay);
    });
}

function isBrowserWebSocket (socket: any): socket is WebSocket {
    return !socket.ping;
}

function isNodeWebSocket (socket: any): socket is NodeWebSocket {
    return !isBrowserWebSocket(socket);
}

/**
 * Wraps a DOM socket with EventEmitter-like syntax.
 */
function wrapDOM (socket: WebSocket) {
    function wrapHandler (event: string, fn: (ev: Event) => void) {
        return (ev: Event) => {
            if (event === 'message') {
                fn((<MessageEvent>ev).data);
            } else {
                fn(ev);
            }
        };
    }

    (<any>socket).on = (event: string, listener: (ev: MessageEvent) => void) => {
        const wrapped = wrapHandler(event, listener);
        socket.addEventListener(event, wrapped);
    };

    (<any>socket).once = (event: string, listener: (ev: MessageEvent) => void) => {
        const wrapped = wrapHandler(event, listener);
        socket.addEventListener(event, ev => {
            wrapped(ev);
            socket.removeEventListener(event, wrapped);
        });
    };

    return socket;
}

export interface IGenericWebSocket {
    new (address: string): IGenericWebSocket;
    close() : void;
    on(ev: string, listener: (arg: any) => void): this;
    once(ev: string, listener: (arg: any) => void): this;
    send(data: string): void;
}

/**
 * Manages a connect to Beam's chat servers.
 */
class BeamSocket extends EventEmitter {
    private _addressOffset: number;
    // Spool to store events queued when the connection is lost.
    private _spool: { data: any, resolve: any }[] = [];
    private _addresses: string[];
    // The WebSocket instance we're currently connected with.
    private ws: IGenericWebSocket;
    private _pingTimeoutHandle: NodeJS.Timer | number;
    // Counter of the current number of reconnect retries, and the number of
    // retries before we reset our reconnect attempts.
    private _retries: number = 0;
    private _retryWrap: number = 7; // max 2 minute retry time;
    private _reconnectTimeout: NodeJS.Timer | number;
    private _callNo: number;
    private status: number;
    private _authpacket: [number, number, string];
    private _replies: { [key: string]: Reply };

    /**
     * We've not tried connecting yet
     */
    public static IDLE = 0;
    /**
     * We successfully connected
     */
    public static CONNECTED = 1;
    /**
     * The socket was is closing gracefully.
     */
    public static CLOSING = 2;
    /**
     * The socket was closed gracefully.
     */
    public static CLOSED = 3;
    /**
     * We're currently trying to connect.
     */
    public static CONNECTING = 4;

    public static Promise: typeof Promise;

    constructor (
        private wsCtor: IGenericWebSocket,
        addresses: string[],
        private options: { pingInterval: number, pingTimeout: number, callTimeout: number}
    ) {
        super();

        this.options = Object.assign({
            pingInterval: 15 * 1000,
            pingTimeout: 5 * 1000,
            callTimeout: 20 * 1000,
        }, options);

        // Which connection we use in our load balancing.
        this._addressOffset = Math.floor(Math.random() * addresses.length);

        // List of addresses we can connect to.
        this._addresses = addresses;

        // Information for server pings. We ping the server on the interval
        // (if we don't get any other packets) and consider a connection
        // dead if it doesn't respond within the timeout.
        this._pingTimeoutHandle = null;

        // The status of the socket connection.
        this.status = BeamSocket.IDLE;

        // Timeout waiting to reconnect
        this._reconnectTimeout = null;

        // Map of call IDs to promises that should be resolved on
        // method responses.
        this._replies = {};

        // Authentication packet store that we'll resend if we have to reconnect.
        this._authpacket = null;

        // Counter for method calls.
        this._callNo = 0;
    }

    /**
     * Gets the status of the socket connection.
     */
    public getStatus (): number {
        return this.status;
    }

    /**
     * Returns whether the socket is currently connected.
     */
    public isConnected (): boolean {
        return this.status === BeamSocket.CONNECTED;
    }

    /**
     * Retrieves a chat endpoint to connect to. We use round-robin balancing.
     */
    protected getAddress (): string {
        if (++this._addressOffset >= this._addresses.length) {
            this._addressOffset = 0;
        }

        return this._addresses[this._addressOffset];
    };

    /**
     * Returns how long to wait before attempting to reconnect. This does TCP-style
     * limited exponential backoff.
     */
    private _getNextReconnectInterval (): number {
        const power = (this._retries++ % this._retryWrap) + Math.round(Math.random());
        return (1 << power) * 500;
    };

    /**
     * _handleClose is called when the websocket closes or emits an error. If
     * we weren't gracefully closed, we'll try to reconnect.
     */
    private _handleClose () {
        clearTimeout(<number>this._pingTimeoutHandle);
        this._pingTimeoutHandle = null;

        this.ws = null;
        this.removeAllListeners('WelcomeEvent');

        if (this.status === BeamSocket.CLOSING) {
            this.status = BeamSocket.CLOSED;
            this.emit('closed');
            return;
        }

        const interval = this._getNextReconnectInterval();
        this.status = BeamSocket.CONNECTING;
        this._reconnectTimeout = setTimeout(this.boot.bind(this), interval);
        this.emit('reconnecting', { interval: interval, socket: this.ws });
    }

    /**
     * Sets the socket to send a ping message after an interval. This is
     * called when a successful ping is received and after data is received
     * from the socket (there's no need to ping when we know the socket
     * is still alive).
     */
    private _resetPingTimeout () {
        clearTimeout(<number>this._pingTimeoutHandle);

        this._pingTimeoutHandle = setTimeout(() => {
            this.ping().catch(() => {});
        }, this.options.pingInterval);
    }

    /**
     * Resets the connection timeout handle. This will run the handler
     * after a short amount of time.
     */
    private _resetConnectionTimeout (handler: () => void) {
        clearTimeout(<number>this._pingTimeoutHandle);
        this._pingTimeoutHandle = setTimeout(handler, this.options.pingTimeout);
    }

    /**
     * Ping runs a ping against the server and returns a promise which is
     * resolved if the server responds, or rejected on timeout.
     */
    public ping (): Promise<void> {
        const { ws } = this;
        clearTimeout(<number>this._pingTimeoutHandle);

        if (!this.isConnected()) {
            return new BeamSocket.Promise<void>((_resolve, reject) => {
                reject(new TimeoutError());
            });
        }

        let promise: Promise<any>;

        if (isNodeWebSocket(ws)) {
            // Node's ws module has a ping function we can use rather than
            // sending a message. More lightweight, less noisy.
            promise = BeamSocket.Promise.race([
                timeout(this.options.pingTimeout),
                new BeamSocket.Promise<void>(resolve => ws.once('pong', resolve)),
            ]);
            ws.ping();
        } else {
            // Otherwise we'll resort to sending a ping message over the socket.
            promise = this.call('ping', [], { timeout: this.options.pingTimeout });
        }

        return promise
        .then(this._resetPingTimeout.bind(this))
        .catch((err: Error) => {
            if (!(err instanceof TimeoutError)) {
                throw err;
            }

            // If we haven't noticed the socket is dead since we started trying
            // to ping, manually emit an error. This'll cause it to close.
            if (this.ws === ws) {
                this.emit('error', err);
                ws.close();

                // trigger a close immediately -- some browsers are slow about this,
                // leading to a delay before we try reconnecting.
                this._handleClose();
            }

            throw err;
        });
    };

    /**
     * Starts a socket client. Attaches events and tries to connect to a
     * chat server.
     * @access public
     * @fires BeamSocket#connected
     * @fires BeamSocket#closed
     * @fires BeamSocket#error
     */
    public boot () {
        const ws = this.ws = new this.wsCtor(this.getAddress());
        if (isBrowserWebSocket(ws)) {
            wrapDOM(<WebSocket><any>ws);
        }
        const whilstSameSocket = (fn: (...inArgs: any[]) => void) => {
            return (...args: any[]) => {
                if (this.ws === ws) {
                    fn.apply(self, args);
                }
            };
        };

        this.status = BeamSocket.CONNECTING;

        // If the connection doesn't open fast enough
        this._resetConnectionTimeout(() => { ws.close(); });

        // Websocket connection has been established.
        ws.on('open', whilstSameSocket(() => {
            // If we don't get a WelcomeEvent, kill the connection
            this._resetConnectionTimeout(() => { ws.close(); });
        }));

        // Chat server has acknowledged our connection
        this.once('WelcomeEvent', function () {
            this._resetPingTimeout();
            this.unspool.apply(this, arguments);
        });

        // We got an incoming data packet.
        ws.on('message', whilstSameSocket(function () {
            this._resetPingTimeout();
            this.parsePacket.apply(this, arguments);
        }));

        // Websocket connection closed
        ws.on('close', whilstSameSocket(function () {
            this._handleClose.apply(this, arguments);
        }));

        // Websocket hit an error and is about to close.
        ws.on('error', whilstSameSocket((err: Error) => {
            this.emit('error', err);
            ws.close();
        }));

        return this;
    };

    /**
     * Should be called on reconnection. Authenticates and sends follow-up
     * packets if we have any. After we get re-established with auth
     * we'll formally say this socket is connected. This is to prevent
     * race conditions where packets could get send before authentication
     * is reestablished.
     */
    protected unspool () {
        // Helper function that's called when we're fully reestablished and
        // ready to take direct calls again.
        function bang () {
            // Send any spooled events that we have.
            for (var i = 0; i < this._spool.length; i++) {
                this.send(this._spool[i].data, { force: true });
                this._spool[i].resolve();
            }
            this._spool = [];

            // Finally, tell the world we're connected.
            this._retries = 0;
            this.status = BeamSocket.CONNECTED;
            this.emit('connected');
        }

        // If we already authed, it means we're reconnecting and should
        // establish authentication again.
        if (this._authpacket) {
            this.call(authMethod, this._authpacket, { force: true })
            .then(result => this.emit('authresult', result))
            .then(bang)
            .catch(() => {
                this.emit('error', new AuthenticationFailedError('?'));
                this.close();
            });
        } else {
            // Otherwise, we can reestablish immediately
            bang();
        }
    };

    /**
     * Parses an incoming packet from the websocket.
     * @fires BeamSocket#error
     * @fires BeamSocket#packet
     */
    protected parsePacket (data: string, flags?: { binary: boolean }) {
        if (flags && flags.binary) {
            // We can't handle binary packets. Why the fudge are we here?
            this.emit('error', new BadMessageError('Cannot parse binary packets. Wat.'));
            return;
        }

        // Unpack the packet data.
        let packet: { id: number, type: string, event: any, data: any, error: string };
        try {
            packet = JSON.parse(data);
        } catch (e) {
            this.emit('error', new BadMessageError('Unable to parse packet as json'));
            return;
        }

        this.emit('packet', packet);

        switch (packet.type) {
        case 'reply':
            // Try to look up the packet reply handler, and call it if we can.
            const reply = this._replies[packet.id];
            if (typeof reply !== 'undefined') {
                reply.handle(packet);
                delete this._replies[packet.id];
            } else {
                // Otherwise emit an error. This might happen occasionally,
                // but failing silently is lame.
                this.emit('error', new NoMethodHandlerError('No handler for reply ID.'));
            }
            break;
        case 'event':
            // Just emit events out on this emitter.
            this.emit(packet.event, packet.data);
            break;
        default:
            this.emit('error', new BadMessageError('Unknown packet type ' + packet.type));
        }
    }

    /**
     * Sends raw packet data to the server. It may not send immediately;
     * if we aren't connected, it'll just be spooled up.
     *
     * @fires BeamSocket#sent
     * @fires BeamSocket#spooled
     */
    protected send (
        data: { id: number, type: string, method: string, arguments: any[] },
        options: { force?: boolean } = {}
    ): Promise<void> {
        if (this.isConnected() || options.force) {
            this.ws.send(JSON.stringify(data));
            this.emit('sent', data);
            return BeamSocket.Promise.resolve();
        } else if (data.method !== authMethod) {
            return new BeamSocket.Promise<void>(resolve => {
                this._spool.push({ data: data, resolve });
                this.emit('spooled', data);
            });
        }

        return BeamSocket.Promise.resolve();
    }

    /**
     * auth sends a packet over the socket to authenticate with a chat server
     * and join a specified channel. If you wish to join anonymously, user
     * and authkey can be omitted.
     */
    public auth (id: number, user: number, authkey: string): Promise<string> {
        this._authpacket = [id, user, authkey];

        // Two cases here: if we're already connected, with send the auth
        // packet immediately. Otherwise we wait for a `connected` event,
        // which won't be sent until after we re-authenticate.
        if (this.isConnected()) {
            return this.call('auth', [id, user, authkey]);
        }

        return new BeamSocket.Promise(resolve => this.once('authresult', resolve));
    };

    /**
     * Runs a method on the socket. Returns a promise that is rejected or
     * resolved upon reply.
     * @access public
     * @param  {String} method
     * @param  {Array=[]} args_ Additional arguments to pass to the method.
     * @param  {Options={}} options_
     * @return {Promise}
     */
    public call <T>(method: string, args: any[] = [], options: { noReply?: boolean, timeout?: number, force?: boolean } = {}): Promise<T> {
        // Send out the data
        const id = this._callNo++;

        // This is created before we call and wait on .send purely for ease
        // of use in tests, so that we can mock an incoming packet synchronously.
        const replyPromise = new BeamSocket.Promise((resolve, reject) => {
            this._replies[id] = new Reply(resolve, reject);
        });

        return this.send({
            type: 'method',
            method: method,
            arguments: args,
            id: id,
        }, options)
        .then(() => {
            // Then create and return a promise that's resolved when we get
            // a reply, if we expect one to be given.
            if (options.noReply) {
                return undefined;
            }

            return BeamSocket.Promise.race([
                <Promise<T>><any>timeout(options.timeout || this.options.callTimeout),
                <Promise<T>><any>replyPromise,
            ]);
        })
        .catch((err: Error) => {
            if (err instanceof TimeoutError) {
                delete this._replies[id];
            }
            throw err;
        });
    };

    /**
     * Closes the websocket gracefully.
     */
    public close () {
        if (this.ws) {
            this.ws.close();
            this.status = BeamSocket.CLOSING;
        } else {
            clearTimeout(<number>this._reconnectTimeout);
            this.status = BeamSocket.CLOSED;
        }
    };
}