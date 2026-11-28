'use strict';

const configuredMax = Number(process.env.WhitelistEmbeddingModelMaxToken);
const modelMaxTokens = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax : 8000;
const chunkMaxTokens = Math.max(1, Math.floor(modelMaxTokens * 0.85));
const chunkOverlapTokens = Math.min(Math.floor(chunkMaxTokens * 0.1), chunkMaxTokens - 1);
// 只放宽单条准入，保留现有聚批上限；超出聚批预算的合法单条独占请求。
const batchTargetTokens = chunkMaxTokens;
const inputMaxTokens = Math.max(chunkMaxTokens, Math.floor(modelMaxTokens * 0.90));

module.exports = { modelMaxTokens, chunkMaxTokens, chunkOverlapTokens, batchTargetTokens, inputMaxTokens };
