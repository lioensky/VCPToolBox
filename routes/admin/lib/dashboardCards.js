function clampInteger(value, fallback, minimum, maximum) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(numericValue)));
}

function normalizeSize(rawSize, fallback, minimums, maximums) {
  return {
    desktopCols: clampInteger(
      rawSize && rawSize.desktopCols,
      fallback.desktopCols,
      minimums.desktopCols,
      maximums.desktopCols
    ),
    tabletCols: clampInteger(
      rawSize && rawSize.tabletCols,
      fallback.tabletCols,
      minimums.tabletCols,
      maximums.tabletCols
    ),
    rows: clampInteger(rawSize && rawSize.rows, fallback.rows, minimums.rows, maximums.rows),
  };
}

function normalizeRenderer(pluginName, renderer) {
  if (!renderer || typeof renderer !== 'object') {
    return null;
  }

  if (renderer.kind === 'builtin') {
    const componentKey =
      typeof renderer.componentKey === 'string' ? renderer.componentKey.trim() : '';

    if (!componentKey) {
      return null;
    }

    return {
      kind: 'builtin',
      componentKey,
    };
  }

  if (renderer.kind === 'web-component') {
    const entry = typeof renderer.entry === 'string' ? renderer.entry.trim() : '';
    const tagName = typeof renderer.tagName === 'string' ? renderer.tagName.trim() : '';

    if (!entry || entry.startsWith('/') || entry.includes('..') || entry.includes('\\')) {
      return null;
    }

    if (!tagName || !tagName.includes('-')) {
      return null;
    }

    return {
      kind: 'web-component',
      entry,
      tagName,
      publicPath: `/AdminPanel/plugin-assets/${encodeURIComponent(pluginName)}/${entry}`,
    };
  }

  return null;
}

function readPluginDashboardCards(pluginName, manifest) {
  const cards =
    manifest &&
    manifest.adminPanel &&
    manifest.adminPanel.dashboard &&
    Array.isArray(manifest.adminPanel.dashboard.cards)
      ? manifest.adminPanel.dashboard.cards
      : [];

  return cards.flatMap((card) => {
    if (!card || typeof card !== 'object') {
      return [];
    }

    const localTypeId = typeof card.typeId === 'string' ? card.typeId.trim() : '';
    const title = typeof card.title === 'string' ? card.title.trim() : '';
    const renderer = normalizeRenderer(pluginName, card.renderer);

    if (!localTypeId || !title || !renderer) {
      return [];
    }

    const defaultSize = normalizeSize(
      card.defaultSize,
      { desktopCols: 6, tabletCols: 6, rows: 16 },
      { desktopCols: 1, tabletCols: 1, rows: 4 },
      { desktopCols: 12, tabletCols: 6, rows: 40 }
    );
    const minSize = normalizeSize(
      card.minSize,
      { desktopCols: Math.min(defaultSize.desktopCols, 4), tabletCols: 3, rows: 8 },
      { desktopCols: 1, tabletCols: 1, rows: 4 },
      { desktopCols: defaultSize.desktopCols, tabletCols: defaultSize.tabletCols, rows: defaultSize.rows }
    );
    const maxSize = normalizeSize(
      card.maxSize,
      { desktopCols: 12, tabletCols: 6, rows: 40 },
      { desktopCols: defaultSize.desktopCols, tabletCols: defaultSize.tabletCols, rows: defaultSize.rows },
      { desktopCols: 12, tabletCols: 6, rows: 60 }
    );

    return [
      {
        typeId: `plugin.${pluginName}.${localTypeId}`,
        localTypeId,
        pluginName,
        source: 'plugin',
        title,
        description:
          typeof card.description === 'string' && card.description.trim()
            ? card.description.trim()
            : manifest.description || '',
        singleton: card.singleton !== false,
        defaultEnabled: card.defaultEnabled === true,
        legacyId:
          typeof card.legacyId === 'string' && card.legacyId.trim()
            ? card.legacyId.trim()
            : null,
        defaultSize,
        minSize,
        maxSize,
        renderer,
      },
    ];
  });
}

module.exports = {
  readPluginDashboardCards,
};
