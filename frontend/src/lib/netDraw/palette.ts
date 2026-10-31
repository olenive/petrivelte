/**
 * The colours the net drawing module emits, as SVG presentation attributes.
 *
 * The app's components paint with the theme's CSS variables
 * (`src/lib/theme.css`); a page that loads only this module has none of
 * them, and the public tier's policy refuses inline styles, so the module
 * writes the light theme's values as literals. Each entry names the
 * variable or the component rule it reproduces. A host page restyles by
 * class: a CSS rule beats a presentation attribute.
 */
export const PALETTE = Object.freeze({
	/** `--graph-bg`: the panel's background, which the hollow arrowhead is filled with. */
	graphBg: '#f0f0f0',
	/** `--place-fill`, also the outline of a place's labels and the badge's ring. */
	placeFill: 'white',
	/** `--place-stroke`. */
	placeStroke: '#0066cc',
	/** `--place-text`: a place's name, its count and a token label. */
	placeText: '#333',
	/** `--text-secondary`: a place's type and a transition's subtitle. */
	textSecondary: '#666',
	/** `--transition-fill`, also the outline of a transition's labels. */
	transitionFill: 'white',
	/** `--transition-stroke`. */
	transitionStroke: '#0066cc',
	/** `--transition-text`. */
	transitionText: '#333',
	/** `Transition.svelte` `.disabled-rect`: its stroke, its fill (`--bg-tertiary`), and `.disabled-text`. */
	disabledStroke: '#9ca3af',
	disabledFill: '#f8f9fa',
	disabledText: '#9ca3af',
	/** `Transition.svelte` `.fireable-rect`. */
	fireableStroke: '#22c55e',
	/** `Transition.svelte` `.in-flight-rect`. */
	inFlightStroke: '#f59e0b',
	/** `--edge-input` and `--edge-output`. */
	edgeInput: '#0066cc',
	edgeOutput: '#0066cc',
	/** `--token-stroke`. */
	tokenStroke: '#333',
	/** `--token-badge-fill` and `--token-badge-text`: the badge of a token that holds nets. */
	badgeFill: '#fd7e14',
	badgeText: '#ffffff',
});

/** The app's body font, which its graph inherits (`theme.css`). */
export const FONT_FAMILY = 'system-ui, -apple-system, sans-serif';
