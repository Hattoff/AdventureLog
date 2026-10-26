import { env } from '$env/dynamic/public';

// Vector-tile attributes that hold a place's name (OpenMapTiles schema, used by
// OpenFreeMap and CARTO GL styles).
const NAME_FIELDS = new Set(['name', 'name:latin', 'name:nonlatin', 'name_en', 'name_int']);

/**
 * Language for basemap labels, from PUBLIC_MAP_LABEL_LANGUAGE (e.g. "en").
 * Empty means "leave the style's labels as they are".
 */
export function getMapLabelLanguage(): string {
	return (env.PUBLIC_MAP_LABEL_LANGUAGE ?? '').trim().toLowerCase();
}

function referencesName(value: unknown): boolean {
	if (typeof value === 'string') return /\{name/.test(value);
	if (Array.isArray(value)) {
		if (value[0] === 'get' && typeof value[1] === 'string' && NAME_FIELDS.has(value[1])) {
			return true;
		}
		return value.some(referencesName);
	}
	if (value && typeof value === 'object' && Array.isArray((value as any).stops)) {
		return (value as any).stops.some((stop: unknown[]) => referencesName(stop?.[1]));
	}
	return false;
}

/** Converts a legacy "{field}" token string into an expression. */
function tokenStringToExpression(value: string): unknown {
	const single = value.match(/^\{([^}]+)\}$/);
	if (single) return ['get', single[1]];
	const parts: unknown[] = [];
	const re = /\{([^}]+)\}/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(value))) {
		if (match.index > last) parts.push(value.slice(last, match.index));
		parts.push(['to-string', ['get', match[1]]]);
		last = re.lastIndex;
	}
	if (last < value.length) parts.push(value.slice(last));
	if (parts.length === 0) return value;
	return parts.length === 1 ? parts[0] : ['concat', ...parts];
}

/**
 * Wraps a label so it prefers the given language, falling back to the original.
 * For English: the real English name; otherwise name_en, but only when it differs
 * from the local name (OpenMapTiles copies the local name into name_en when there
 * is no translation); otherwise a Latin-alphabet transliteration; otherwise the
 * style's original label. Each fallback chain is a plain coalesce of lookups so a
 * missing value is skipped rather than shown as an empty label.
 */
function localizeOutput(value: unknown, language: string): unknown {
	const expression = typeof value === 'string' ? tokenStringToExpression(value) : value;
	if (!referencesName(value)) return expression;

	const native = ['get', `name:${language}`];
	if (language !== 'en') return ['coalesce', native, expression];

	return [
		'case',
		['all', ['has', 'name_en'], ['!=', ['get', 'name_en'], ['get', 'name']]],
		['coalesce', native, ['get', 'name_en'], expression],
		['coalesce', native, ['get', 'name:latin'], expression]
	];
}

/** Returns the localized text-field, or null if this label should be left alone. */
function localizeTextField(field: unknown, language: string): unknown | null {
	if (!referencesName(field)) return null;

	// Legacy zoom function: { stops: [[zoom, "{name_en}"], [zoom, "{name}"]] }
	if (field && typeof field === 'object' && !Array.isArray(field)) {
		const stops = (field as any).stops as [number, unknown][];
		if (!Array.isArray(stops) || stops.length === 0 || (field as any).property) return null;
		const step: unknown[] = ['step', ['zoom'], localizeOutput(stops[0][1], language)];
		for (const [zoom, output] of stops.slice(1)) {
			step.push(zoom, localizeOutput(output, language));
		}
		return step;
	}

	// Zoom step expression: localize each output, keep the zoom breakpoints.
	if (Array.isArray(field) && field[0] === 'step' && JSON.stringify(field[1]).includes('"zoom"')) {
		return field.map((part, index) =>
			index >= 2 && index % 2 === 0 ? localizeOutput(part, language) : part
		);
	}

	// Any other zoom-dependent expression must stay top-level; leave it alone.
	if (JSON.stringify(field).includes('"zoom"')) return null;

	return localizeOutput(field, language);
}

/**
 * Rewrites every name label in the current style to prefer the given language,
 * falling back to the style's original label when a place has no translation.
 * Labels that don't show names (road refs, house numbers) are left alone.
 */
export function applyMapLabelLanguage(map: any, language = getMapLabelLanguage()): void {
	if (!language || typeof map?.getStyle !== 'function') return;

	let layers: any[] = [];
	try {
		layers = map.getStyle()?.layers ?? [];
	} catch {
		return;
	}

	for (const layer of layers) {
		if (layer?.type !== 'symbol') continue;
		const field = layer.layout?.['text-field'];
		if (field === undefined) continue;
		const localized = localizeTextField(field, language);
		if (localized === null) continue;

		try {
			map.setLayoutProperty(layer.id, 'text-field', localized);
		} catch {
			// Leave this layer's labels unchanged if the style rejects the expression.
		}
	}
}
