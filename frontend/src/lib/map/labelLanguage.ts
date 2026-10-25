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
	return false;
}

/**
 * Rewrites every name label in the current style to prefer `name:<language>`,
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
		if (field === undefined || !referencesName(field)) continue;
		// Zoom-dependent expressions must stay top-level; don't wrap them.
		if (JSON.stringify(field).includes('"zoom"')) continue;

		const original =
			typeof field === 'string' ? ['coalesce', ['get', 'name_en'], ['get', 'name']] : field;
		const preferred: unknown[] = [['get', `name:${language}`]];
		if (language === 'en') preferred.push(['get', 'name_en']);

		try {
			map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ...preferred, original]);
		} catch {
			// Leave this layer's labels unchanged if the style rejects the expression.
		}
	}
}
