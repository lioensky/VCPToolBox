function createReviewService({ memoStore }) {
  return {
    async search({ q = '', tag = null, from = null, to = null, limit = 20 }) {
      const { items } = await memoStore.list({ limit: 100 });
      const filtered = items.filter((memo) => {
        if (q && !memo.content.toLowerCase().includes(String(q).toLowerCase())) {
          return false;
        }
        if (tag && !memo.tags.includes(tag)) {
          return false;
        }
        if (from && memo.createdAt < `${from}T00:00:00.000Z`) {
          return false;
        }
        if (to && memo.createdAt > `${to}T23:59:59.999Z`) {
          return false;
        }
        return true;
      });

      return {
        items: filtered.slice(0, Math.min(limit, 100)),
      };
    },

    async random() {
      const { items } = await memoStore.list({ limit: 100 });
      if (items.length === 0) {
        throw new Error('MEMO_NOT_FOUND');
      }
      return items[0];
    },

    async daily() {
      const { items } = await memoStore.list({ limit: 100 });
      if (items.length === 0) {
        throw new Error('MEMO_NOT_FOUND');
      }

      const selected = items.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      return {
        ...selected,
        reviewReason: 'earliest_memo_for_daily_review',
      };
    },
  };
}

module.exports = {
  createReviewService,
};
