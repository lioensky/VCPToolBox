'use strict';

function fieldMap(entries) {
    return new Map(
        (Array.isArray(entries) ? entries : [])
            .map(entry => [
                Number(entry?.[0]),
                Math.max(0, Number(entry?.[1]) || 0)
            ])
            .filter(([id, mass]) => Number.isFinite(id) && mass > 0)
    );
}

function normalizeField(field) {
    let maximum = 0;
    for (const value of field.values()) maximum = Math.max(maximum, value);
    if (maximum <= 0) return { field, maximum };
    return {
        field: new Map(
            [...field.entries()].map(([id, value]) => [id, value / maximum])
        ),
        maximum
    };
}

function domainSet(domain) {
    return new Set(
        Array.isArray(domain?.ids)
            ? domain.ids.map(Number).filter(Number.isFinite)
            : []
    );
}

function sourceSet(queryState) {
    return new Set(
        (Array.isArray(queryState?.sourceField) ? queryState.sourceField : [])
            .map(entry => Number(entry?.[0]))
            .filter(Number.isFinite)
    );
}

function createFieldWorkspace(queryState) {
    const localRaw = fieldMap(queryState?.localField);
    const transferRaw = fieldMap(queryState?.transferField);
    const localNormalized = normalizeField(localRaw);
    const transferNormalized = normalizeField(transferRaw);

    return Object.freeze({
        schema: 'tagmemo-v10-query-field-workspace-v1',
        queryId: queryState?.queryId || null,
        localRaw,
        transferRaw,
        local: localNormalized.field,
        transfer: transferNormalized.field,
        localMaximum: localNormalized.maximum,
        transferMaximum: transferNormalized.maximum,
        sourceIds: sourceSet(queryState),
        localDomain: domainSet(queryState?.localDomain),
        transferDomain: domainSet(queryState?.transferDomain)
    });
}

function resolveFieldWorkspace(queryState, options = {}) {
    const workspace = options.fieldWorkspace;
    if (
        workspace?.schema === 'tagmemo-v10-query-field-workspace-v1'
        && (
            !workspace.queryId
            || !queryState?.queryId
            || workspace.queryId === queryState.queryId
        )
    ) {
        return workspace;
    }
    return createFieldWorkspace(queryState);
}

module.exports = {
    fieldMap,
    normalizeField,
    domainSet,
    createFieldWorkspace,
    resolveFieldWorkspace
};