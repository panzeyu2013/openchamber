import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export interface SidebarServerHeaderProps {
  serverId: string;
  label: string;
  type: 'local' | 'ssh' | 'remote-url';
  status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'degraded';
  isCollapsed: boolean;
  isActive: boolean;
  hidden?: boolean;
  errorMessage?: string;
  requiresUserAction?: boolean;
  onToggleCollapse: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export const SidebarServerHeader: React.FC<SidebarServerHeaderProps> = ({
  label,
  type,
  status,
  isCollapsed,
  isActive,
  hidden,
  errorMessage,
  requiresUserAction,
  onToggleCollapse,
  onConnect,
  onDisconnect,
}) => {
  const { t } = useI18n();
  const isErrorWithUserAction = status === 'error' && requiresUserAction;
  return (
    <div
      className={cn(
        'w-full text-left group/server select-none',
        hidden && 'hidden',
      )}
    >
      <div className="relative flex items-center gap-1 px-0.5 py-0.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          )}
        >
          <span className="h-3.5 w-3.5 flex-shrink-0 flex items-center justify-center text-muted-foreground">
            <span className={cn(
              'h-3.5 w-3.5 items-center justify-center',
              'hidden group-hover/server:inline-flex group-focus-within/server:inline-flex',
            )}>
              {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
            </span>
            <span className={cn(
              'h-3.5 w-3.5 items-center justify-center',
              'inline-flex group-hover/server:hidden group-focus-within/server:hidden',
            )}>
              {isErrorWithUserAction ? (
                <Icon name="plug-2" className="h-3 w-3 text-muted-foreground/40" />
              ) : (
                <span className={cn(
                  'h-2 w-2 rounded-full',
                  status === 'connected' && 'bg-status-success',
                  status === 'connecting' && 'bg-status-warning animate-pulse',
                  status === 'degraded' && 'bg-status-warning animate-pulse',
                  status === 'disconnected' && 'bg-muted-foreground/40',
                  status === 'error' && !requiresUserAction && 'bg-status-error',
                  status === 'error' && requiresUserAction && 'bg-muted-foreground/40',
                )}
                  role="status"
                  aria-label={`${t('server.sidebar.status.label', { status })}`}
                  title={status === 'error' ? errorMessage || t('server.sidebar.status.connectionError') : status === 'disconnected' ? t('server.sidebar.status.disconnected') : undefined}
                />
              )}
            </span>
          </span>

          <span className={cn(
            'text-[14px] font-normal truncate',
            isActive ? 'text-foreground' : 'text-muted-foreground',
          )}>
            {label}
          </span>

          {type === 'ssh' && (
            <span className="rounded border border-border/40 px-1.5 py-0.5 typography-micro text-muted-foreground/70 shrink-0">
              SSH
            </span>
          )}
          {type === 'remote-url' && (
            <span className="rounded border border-border/40 px-1.5 py-0.5 typography-micro text-muted-foreground/70 shrink-0">
              REMOTE
            </span>
          )}
        </button>

        {type !== 'local' && status === 'connected' && onDisconnect && (
          <button
            onClick={onDisconnect}
            aria-label={t('server.sidebar.actions.disconnect')}
            className={cn(
              'absolute right-0.5 top-1/2 z-10 -translate-y-1/2',
              'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-opacity',
              'opacity-0 pointer-events-none group-hover/server:opacity-100 group-hover/server:pointer-events-auto group-focus-within/server:opacity-100 group-focus-within/server:pointer-events-auto',
            )}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        )}

        {isErrorWithUserAction && onConnect && (
          <button
            onClick={onConnect}
            className={cn(
              'absolute right-0.5 top-1/2 z-10 -translate-y-1/2',
              'inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-medium',
              'bg-status-error/10 text-status-error hover:bg-status-error/20 transition-colors',
            )}
          >
            {t('server.sidebar.actions.reconnect')}
          </button>
        )}

        {type !== 'local' && !isErrorWithUserAction && status !== 'connected' && status !== 'connecting' && status !== 'degraded' && onConnect && (
          <button
            onClick={onConnect}
            aria-label={t('server.sidebar.actions.connect')}
            className={cn(
              'absolute right-0.5 top-1/2 z-10 -translate-y-1/2',
              'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-opacity opacity-100',
            )}
          >
            <Icon name="plug-2" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {status === 'degraded' && (
        <div className="px-1 pb-0.5">
          <div className="rounded-md bg-status-warning/10 px-2.5 py-1 text-[11px] text-status-warning leading-tight">
            {t('server.sidebar.status.reconnecting', { label })}
          </div>
        </div>
      )}

      {isErrorWithUserAction && (
        <div className="px-1 pb-0.5">
          <div className="rounded-md bg-status-error/10 px-2.5 py-1 text-[11px] text-status-error leading-tight">
            {t('server.sidebar.status.clickToReconnect')}
          </div>
        </div>
      )}
    </div>
  );
};
