import { EventEmitter } from "events";

declare class BeamSocket extends EventEmitter {
  /**
   * Constructor for the class to create the socket handle / connection.
   */
  constructor(addresses: string[]);
  /**
   * Which connection we use in our load balancing.
   */
  private _addressOffset: number;
  /**
   * List of addresses we can connect to.
   */
  private _addresses: string[];
  /**
   * Spool to store events queued when the connection is lost.
   */
  private _spool: string[];
  /**
   * The WebSocket instance we're currently connected with.
   */
  ws: WebSocket;
  /**
   * The status of the socket connection.
   */
  status: number;
  /**
   * Counter of the current number of reconnect retries, and the number of retries before we reset our reconnect attempts.
   */
  private _retries: number;
  /**
   * Max 2 minute retry time.
   */
  private _retryWrap: number;
  /**
   * Timeout waiting to reconnect
   */
  private _reconnectTimeout: any;
  /**
   * Number of milliseconds to wait in .call() before we give up waiting or the reply. Used to prevent leakages.
   */
  callTimeout: number;
  /**
   * Map of call IDs to promises that should be resolved on method responses.
   */
  private _replies: {};
  /**
   * Authentication packet store that we'll resend if we have to reconnect.
   */
  private _authpacket: string;
  /**
   * Counter for method calls.
   */
  private _callNo: number;
  /**
   * The timeout error for the socket.
   */
  TimeoutError: TimeoutError;
  /**
   * Set the socket status values.
   */
  IDLE: number;
  CONNECTED: number;
  CLOSING: number;
  CLOSED: number;
  CONNECTING: number;
  /**
   * Gets the status of the socket connection.
   */
  getStatus(): number;
  /**
   * Returns whether the socket is currently connected.
   */
  isConnected(): boolean;
  /**
   * Retrieves a chat endpoint to connect to. We use round-robin balancing.
   */
  protected getAddress(): string;
  /**
   * Returns how long to wait before attempting to reconnect. This does TCP-style limited exponential backoff.
   */
  private _getNextReconnectInterval(): number;
  /**
   * _handleClose is called when the websocket closes or emits an error. If we weren't gracefully closed, we'll try to reconnect.
   */
  private _handleClose(): void;
  /**
   * Starts a socket client. Attaches events and tries to connect to a chat server.
   */
  boot(): this;
  /**
   * Should be called on reconnection. Authenticates and sends follow-up packets if we have any. After we get re-established with auth
   * we'll formally say this socket is connected. This is to prevent race conditions where packets could get send before authentication
   * is reestablished.
   */
  protected unspool(): void;
  /**
   * Parses an incoming packet from the websocket.
   */
  protected parsePacket(data: string, flags: {}): any;
  /**
   * Sends raw packet data to the server. It may not send immediately; if we aren't connected, it'll just be spooled up.
   */
  protected send(data: {}, options?: { force: boolean }): void;
  /**
   * Auth sends a packet over the socket to authenticate with a chat server and join a specified channel. If you wish to join anonymously, user and authkey can be omitted.
   */
  auth(channelId: number, userId?: number, authKey?: string): Promise<SocketAuthed>;
  /**
   * Runs a method on the socket. Returns a promise that is rejected or resolved upon reply.
   */
  call(method: string, args: (string|number)[], options?: CallOptions): Promise<any>;
  call(method: "auth", args: [number], options?: CallOptions): Promise<SocketAuthed>;
  call(method: "auth", args: [number, number, string], options?: CallOptions): Promise<SocketAuthed>;
  call(method: "msg", args: [string], options?: CallOptions): Promise<any> | Promise<ChatMessage>;
  call(method: "whisper", args: [string, string], options?: CallOptions): Promise<any>;
  call(method: "history", args: [number], options?: CallOptions): Promise<ChatMessage[]>;
  call(method: "timeout", args: [string, string], options?: CallOptions): Promise<string>;

  /**
   * Closes the websocket gracefully.
   */
  close(): void;
  /**
   * Define the "on" methods this socket will emit.
   */
  on(event: string, cb: () => any): this;
  on(event: "connected", cb: () => any): this;
  on(event: "closed", cb: () => any): this;
  on(event: "error", cb: (err: Error) => any): this;
  on(event: "authresult", cb: (res: SocketAuthed) => any): this;
  on(event: "packet", cb: (packet: any) => any): this;
  on(event: "ChatMessage", cb: (message: ChatMessage) => any): this;
  on(event: "UserUpdate", cb: (update: UserUpdate) => any): this;
  on(event: "PollStart", cb: (poll: PollStart) => any): this;
  on(event: "PollEnd", cb: (poll: PollEnd) => any): this;
  on(event: "UserJoin", cb: (join: UserJoin) => any): this;
  on(event: "UserLeave", cb: (join: UserLeave) => any): this;
  on(event: "ClearMessages", cb: () => any): this;
  on(event: "DeleteMessage", cb: (message: DeleteMessage) => any): this;
  on(event: "PurgeMessage", cb: (purge: PurgeMessage) => any): this;
  on(event: "UserTimeout", cb: (timeout: UserTimeout) => any): this;
}

interface TimeoutError extends Error {}

interface CallOptions {
  /**
   * Set to false if you want a Promise to return for when the event is sent and received by the chat server.
   */
  noReply?: boolean;
  /**
   * Set to true if you want to force send a event to the server.
   */
  force?: boolean;
}

interface SocketAuthed {
  /**
   * If you are authenticated on the socket.
   */
  authenticated: boolean;
  /**
   * The roles the user has.
   */
  roles: string[];
}

interface ChatMessage {
  /**
   * The Id of the message.
   */
  id: string;
  /**
   * The channel Id.
   */
  channel: number;
  /**
   * The user's Id.
   */
  user_id: number;
  /**
   * The user's name.
   */
  user_name: string;
  /**
   * The roles the user has.
   */
  user_roles: string[];
  /**
   * The message payload.
   */
  message: {
    /**
     * The message packets.
     */
    message: BeamMessage[];
    /**
     * The meta for the message.
     */
    meta: {
      me?: boolean;
      whisper?: boolean;
    }
  };
}

interface BeamMessage {
  /**
   * The type of the message part.
   */
  type: "text" | "link" | "emoticon" | "tag" | "inaspacesuit";
  /**
   * The source of the emote.
   */
  source?: "builtint" | "external";
  /**
   * The URL to the sprite sheet for the emote.
   */
  pack?: string;
  /**
   * The location of the emote on the sprite sheet.
   */
  coords?: {
    x: number;
    y: number;
  };
  /**
   * The Id of the user name. (Defined when you are handling a "tag" part)
   */
  id?: number;
  /**
   * The username of the user. (Defined when you are handling a "tag" part)
   */
  username?: string;
  /**
   * The raw text value of the message part.
   */
  text?: string;
}

interface UserUpdate {
  /**
   * The user's Id.
   */
  user: number;
  /**
   * The username for the user. (This could be the new name if the user changes their name)
   */
  username: string;
  /**
   * The roles the user has.
   */
  roles: string[];
  /**
   * The permissions which the user has.
   */
  permissions: string[];
}

interface PollStart {
  /**
   * The question being asked.
   */
  q: string;
  /**
   * The answers for the poll.
   */
  answers: string[];
  /**
   * The duration for the poll.
   */
  duration: number;
  /**
   * The ISO time for when the poll ends.
   */
  endsAt: number;
}

interface PollEnd {
  /**
   * How many users entered the poll.
   */
  voters: number;
  /**
   * The responses for the poll.
   */
  responses: Array<{
    [answer: string]: number;
  }>;
}

interface UserJoin {
  /**
   * The user's Id.
   */
  id: number;
  /**
   * The user's name.
   */
  username: string;
  /**
   * The roles the user has.
   */
  roles: string[];
}

interface UserLeave {
  /**
   * The user's Id.
   */
  id: number;
  /**
   * The user's name.
   */
  username: string;
}

interface DeleteMessage {
  /**
   * The message Id.
   */
  id: string;
}

interface PurgeMessage {
  /**
   * The user's Id.
   */
  user_id: number;
}

interface UserTimeout {
  user: {
    /**
     * The user's Id.
     */
    user_id: number;
    /**
     * The user's name.
     */
    user_name: string;
    /**
     * The roles the user has.
     */
    user_roles: string[];
  },
  /**
   * The duration of the timeout.
   */
  duration: number;
}

export = BeamSocket;
