'use client';

import { useEffect, useId, useRef, type RefObject } from 'react';
import { cn } from '@/lib/utils';

/**
 * The mascot: the little screen from the logo, with rabbit-ear antennas and
 * a stand. It keeps people company where the app has nothing to show yet
 * (the front page, an empty room, an empty queue).
 *
 * Moods change only the face. All motion is CSS (`app/globals.css`, the
 * `mascot-*` rules), so the global reduced-motion rule stills it.
 */
export type MascotMood = 'idle' | 'happy' | 'sleepy' | 'sad';

const EYE_COLOR = '#0b4f46';
const SCREEN_COLOR = '#effcf9';
const CHEEK_COLOR = '#ff9fb0';
/** How far the pupils move towards the pointer, in viewBox units. */
const LOOK_RANGE = 3.2;
/** Pointer distance (px) at which the eyes reach their range. */
const LOOK_DISTANCE_PX = 360;

export function Mascot({ mood = 'idle', followPointer = false, className, label }: {
    mood?: MascotMood;
    /** The eyes follow the pointer around the page. */
    followPointer?: boolean;
    className?: string;
    /** Accessible description; without one the mascot is decorative. */
    label?: string;
}) {
    const gradient = `wt-mascot-${useId().replace(/:/g, '')}`;
    const svgRef = useRef<SVGSVGElement>(null);
    const eyesRef = useRef<SVGGElement>(null);

    useEffect(() => {
        if (!followPointer) return;
        let frame = 0;
        const onMove = (event: PointerEvent) => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const svg = svgRef.current;
                const eyes = eyesRef.current;
                if (!svg || !eyes) return;
                const box = svg.getBoundingClientRect();
                const dx = event.clientX - (box.left + box.width / 2);
                const dy = event.clientY - (box.top + box.height / 2);
                const reach = Math.min(1, Math.hypot(dx, dy) / LOOK_DISTANCE_PX);
                const angle = Math.atan2(dy, dx);
                eyes.style.transform = `translate(${(Math.cos(angle) * reach * LOOK_RANGE).toFixed(2)}px, ${(Math.sin(angle) * reach * LOOK_RANGE * 0.7).toFixed(2)}px)`;
            });
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('pointermove', onMove);
        };
    }, [followPointer]);

    return (
        <svg
            ref={svgRef}
            viewBox="0 0 80 80"
            className={cn('mascot overflow-visible', className)}
            data-mascot={mood}
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
            focusable="false"
        >
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#34cdb9" />
                    <stop offset="1" stopColor="#0e8f7d" />
                </linearGradient>
            </defs>
            <ellipse className="mascot-shadow" cx="40" cy="75" rx="17" ry="2.6" fill="#000000" opacity="0.18" />
            <g className="mascot-body">
                {/* Rabbit-ear antennas */}
                <g stroke={`url(#${gradient})`} strokeWidth="2.6" strokeLinecap="round">
                    <path d="M33 15 25.5 4.5" />
                    <path d="M47 15 54.5 4.5" />
                </g>
                <circle cx="25" cy="4" r="2.6" fill="#34cdb9" />
                <circle cx="55" cy="4" r="2.6" fill="#34cdb9" />
                {/* Stand */}
                <rect x="36" y="56" width="8" height="9" rx="2" fill="#0e8f7d" />
                <path d="M30 67h20" stroke="#0e8f7d" strokeWidth="5" strokeLinecap="round" />
                {/* Bezel and screen */}
                <rect x="7" y="14" width="66" height="45" rx="14" fill={`url(#${gradient})`} />
                <rect x="12.5" y="19.5" width="55" height="34" rx="9.5" fill={SCREEN_COLOR} />
                <Face mood={mood} eyesRef={eyesRef} glance={!followPointer} />
            </g>
        </svg>
    );
}

function Face({ mood, eyesRef, glance }: { mood: MascotMood; eyesRef: RefObject<SVGGElement | null>; glance: boolean }) {
    const arc = { fill: 'none', stroke: EYE_COLOR, strokeWidth: 2.8, strokeLinecap: 'round' as const };
    return (
        <g className={mood === 'idle' && glance ? 'mascot-look' : undefined}>
            <g ref={eyesRef} className="mascot-eyes">
                {mood === 'idle' && (
                    <>
                        <ellipse className="mascot-eye" cx="31" cy="36" rx="3.6" ry="5.2" fill={EYE_COLOR} />
                        <ellipse className="mascot-eye" cx="49" cy="36" rx="3.6" ry="5.2" fill={EYE_COLOR} />
                    </>
                )}
                {mood === 'happy' && (
                    <>
                        <path d="M27 38.5q4-6 8 0" {...arc} />
                        <path d="M45 38.5q4-6 8 0" {...arc} />
                    </>
                )}
                {mood === 'sleepy' && (
                    <>
                        <path d="M27 36.5q4 3.5 8 0" {...arc} />
                        <path d="M45 36.5q4 3.5 8 0" {...arc} />
                    </>
                )}
                {mood === 'sad' && (
                    <>
                        <ellipse cx="31" cy="37.5" rx="3.2" ry="4.2" fill={EYE_COLOR} />
                        <ellipse cx="49" cy="37.5" rx="3.2" ry="4.2" fill={EYE_COLOR} />
                        <path d="M26.5 30.5 34 29" {...arc} strokeWidth={2.2} />
                        <path d="M53.5 30.5 46 29" {...arc} strokeWidth={2.2} />
                    </>
                )}
            </g>
            {mood === 'happy' && (
                <>
                    <circle cx="22.5" cy="44" r="3" fill={CHEEK_COLOR} opacity="0.7" />
                    <circle cx="57.5" cy="44" r="3" fill={CHEEK_COLOR} opacity="0.7" />
                </>
            )}
            {mood === 'sleepy' && (
                <g fill={EYE_COLOR} fontFamily="inherit" fontWeight="600">
                    <text className="mascot-z" x="58" y="30" fontSize="7">z</text>
                    <text className="mascot-z mascot-z-late" x="62" y="25" fontSize="5.5">z</text>
                </g>
            )}
        </g>
    );
}
