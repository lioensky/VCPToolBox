const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  MEMO_NOT_FOUND: 'MEMO_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

function memoError(res, code, message, status) {
  return res.status(status).json({
    error: {
      code,
      message,
      status,
    },
  });
}

module.exports = {
  ERROR_CODES,
  memoError,
};
