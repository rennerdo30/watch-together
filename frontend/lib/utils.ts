import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility for merging Tailwind classes with clsx
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/** A member's identity as a short label: the part before the @ of an email. */
export function displayName(identity: string): string {
    const at = identity.indexOf('@');
    return at > 0 ? identity.slice(0, at) : identity;
}

/** Host name for display, tolerating anything the resolver hands back. */
export function displayHost(url: string): string {
    try {
        return new URL(url).hostname.replace('www.', '');
    } catch {
        return url;
    }
}
