/**
 * Mono downmix for the player's audio graph.
 *
 * A node that declares an explicit input channel count of one folds whatever
 * reaches it — stereo, 5.1 — into a single channel using the Web Audio
 * up/down-mix rules (stereo becomes (L+R)/2). The destination then spreads
 * that one channel back over every speaker, so both ears hear the same mix.
 * That is what a viewer listening through one earbud, or with hearing in one
 * ear, needs: without it, anything panned hard to the side they cannot hear
 * is simply missing.
 *
 * The configuration is a separate exported constant so a test can render it
 * through an OfflineAudioContext and assert on the samples, rather than on the
 * properties it just set.
 */
export const MONO_DOWNMIX_CONFIG = {
    channelCount: 1,
    // The default, 'max', takes the count from the input and would pass a
    // stereo signal through untouched: the downmix depends on 'explicit'.
    channelCountMode: 'explicit',
    // 'discrete' would drop the right channel instead of mixing it in.
    channelInterpretation: 'speakers',
} as const satisfies Pick<AudioNode, 'channelCount' | 'channelCountMode' | 'channelInterpretation'>;

/** A unity-gain node that outputs the mono sum of everything connected to it. */
export function createMonoDownmix(context: BaseAudioContext): GainNode {
    const node = context.createGain();
    node.channelCount = MONO_DOWNMIX_CONFIG.channelCount;
    node.channelCountMode = MONO_DOWNMIX_CONFIG.channelCountMode;
    node.channelInterpretation = MONO_DOWNMIX_CONFIG.channelInterpretation;
    return node;
}
