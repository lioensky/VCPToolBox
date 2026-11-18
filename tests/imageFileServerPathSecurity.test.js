const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsParentDirectorySegment,
  stopSecurityManager
} = require('../Plugin/ImageFileServer/image-file-server.js');

test.after(() => {
  stopSecurityManager();
});

test('allows ordinary repeated dots inside media title path segments', () => {
  const reportedPath = '/bilibili/%E5%8F%AF%E6%8E%A7%E8%81%9A%E5%8F%98%E6%98%AF%E7%BB%88%E6%9E%81%E8%83%BD%E6%BA%90......%E5%90%97%EF%BC%9F/hd_snapshot_BV1xNNZ6XEu9_300s.jpg';

  assert.equal(containsParentDirectorySegment(reportedPath), false);
  assert.equal(containsParentDirectorySegment('/bilibili/title...with...dots/image.jpg'), false);
  assert.equal(containsParentDirectorySegment('/bilibili/......../image.jpg'), false);
});

test('rejects literal and URL-encoded parent directory segments', () => {
  const dangerousPaths = [
    '/../secret.jpg',
    '/safe/../secret.jpg',
    '/safe/..',
    '/safe/%2e%2e/secret.jpg',
    '/safe/%2E%2E/secret.jpg',
    '/safe/%2e./secret.jpg',
    '/safe/.%2e/secret.jpg'
  ];

  for (const requestedPath of dangerousPaths) {
    assert.equal(
      containsParentDirectorySegment(requestedPath),
      true,
      `expected parent directory segment to be rejected: ${requestedPath}`
    );
  }
});

test('does not confuse dot-prefixed or dot-containing names with parent traversal', () => {
  const safePaths = [
    '/safe/.../image.jpg',
    '/safe/..title/image.jpg',
    '/safe/title../image.jpg',
    '/safe/a..b/image.jpg',
    '/safe/.hidden/image.jpg'
  ];

  for (const requestedPath of safePaths) {
    assert.equal(
      containsParentDirectorySegment(requestedPath),
      false,
      `expected ordinary path segment to be allowed: ${requestedPath}`
    );
  }
});

test('treats malformed URL encoding as unsafe', () => {
  assert.equal(containsParentDirectorySegment('/safe/%E0%A4%A/image.jpg'), true);
});