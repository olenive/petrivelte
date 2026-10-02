/**
 * Timing of the firing animation on the nets page.
 *
 * A firing plays in two stages of equal length: the consumed tokens travel
 * from their places to the transition, then the produced tokens travel from
 * the transition out to their places. At 300 ms a stage the movement read as
 * a flicker, so it runs at 1200 ms, slow enough to follow which token went
 * where.
 */
export const TOKEN_STAGE_MS = 1200;

/** Both stages back to back: how long the page is busy with one firing. */
export const FIRING_ANIMATION_MS = 2 * TOKEN_STAGE_MS;
