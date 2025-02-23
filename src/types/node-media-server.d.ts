declare module 'node-media-server' {
  import { EventEmitter } from 'events';
  import { Application } from 'express';
  import { Server } from 'http';

  interface NodeHttpServer {
    server: Server;
    app: Application;
    port: number;
  }

  export interface NodeMediaServerConfig {
    rtmp?: {
      port: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
    http?: {
      port: number;
      webroot?: string;
      mediaroot?: string;
      allow_origin?: string;
      api?: boolean;
      api_user?: string;
      api_pass?: string;
    };
    auth?: {
      api?: boolean;
      api_user?: string;
      api_pass?: string;
      play?: boolean;
      publish?: boolean;
      secret?: string;
    };
  }

  export class NodeMediaSession extends EventEmitter {
    id: string;
    streamPath: string;
    reject(): void;
    stop(): void;
  }

  class NodeMediaServer extends EventEmitter {
    constructor(config: NodeMediaServerConfig);
    run(): void;
    stop(): void;
    getSession(id: string): NodeMediaSession | null;
    
    // HTTP Server property properly typed
    nhs: NodeHttpServer | undefined;
  }

  export { NodeMediaSession as Session };
  export default NodeMediaServer;
}