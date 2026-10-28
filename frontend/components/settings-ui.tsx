import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The building blocks every settings surface uses (the room settings dialog,
 * the player's settings menu), so a setting looks the same wherever it lives:
 * a title, one line of help, and its control on the right. No tinted cards:
 * the state is the control's, not the row's.
 */

export function Switch({ checked, onChange, label, disabled = false, id }: {
    checked: boolean;
    onChange: (next: boolean) => void;
    /** Accessible name; usually the row's title. */
    label: string;
    disabled?: boolean;
    id?: string;
}) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
                checked ? 'bg-[color:var(--accent-primary)]' : 'bg-neutral-700',
            )}
        >
            {/* A literal white: `bg-white` is the ink colour in the light scheme. */}
            <span
                aria-hidden="true"
                className={cn(
                    'h-4 w-4 rounded-full bg-[#ffffff] shadow-sm transition-transform',
                    checked ? 'translate-x-[18px]' : 'translate-x-0.5',
                )}
            />
        </button>
    );
}

export function SettingRow({ title, description, control, htmlFor, children, testId, className }: {
    title: ReactNode;
    description?: ReactNode;
    /** Sits to the right of the title. */
    control?: ReactNode;
    /** The control the title labels, so clicking the title operates it. */
    htmlFor?: string;
    /** Full-width content under the title (a list of options, a slider). */
    children?: ReactNode;
    testId?: string;
    className?: string;
}) {
    const Title = htmlFor ? 'label' : 'p';
    return (
        <div data-testid={testId} className={cn('py-3.5', className)}>
            <div className="flex items-start justify-between gap-6">
                <div className="min-w-0">
                    <Title htmlFor={htmlFor} className="ui-title block">{title}</Title>
                    {description && <p className="ui-meta mt-0.5">{description}</p>}
                </div>
                {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
            </div>
            {children && <div className="mt-3">{children}</div>}
        </div>
    );
}

export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <section className="mb-6 last:mb-0">
            {title && <h3 className="ui-label mb-1">{title}</h3>}
            <div className="divide-y divide-[color:var(--border-subtle)]">{children}</div>
        </section>
    );
}

/** Secondary button used inside settings: neutral, compact. */
export const SETTINGS_BUTTON =
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-neutral-200 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40';

/** Primary button used inside settings. */
export const SETTINGS_PRIMARY_BUTTON =
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent-primary)] px-3 text-xs font-medium on-accent transition-[filter] hover:brightness-110 disabled:opacity-40';
