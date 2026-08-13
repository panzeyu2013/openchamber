import type { Express } from "express";
import type { Server } from "http";

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  isReady: () => boolean;
  restartOpenCode: () => Promise<void>;
  /**
   * Registers a privileged workspace Connection Broker adapter at runtime
   * (used by the Electron main process for freshly created SSH instances):
   * seeds its private profile when none exists and starts the session-index
   * observer. Idempotent for a duplicate adapter.
   */
  registerWorkspaceConnectionAdapter?: (adapter: unknown) => Promise<boolean>;
  /**
   * Detaches a privileged adapter at runtime (SSH instance removed). Stops
   * the observer; the saved profile is kept so catalog workspaces stay
   * resolvable as offline.
   */
  unregisterWorkspaceConnectionAdapter?: (connectionId: string) => Promise<boolean>;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  /** Server-side resolver for private workspace connection credentials. */
  workspaceCredentialProvider?: {
    resolveCredential: (credentialRef: string) => Promise<Record<string, unknown> | null>;
  } | null;
  /** Privileged workspace adapters supplied by a native host (for example SSH). */
  workspaceConnectionAdapters?: unknown[];
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
