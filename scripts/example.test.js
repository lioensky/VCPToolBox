// example.test.js
// This is a simple test case to verify Jest setup.

// A simple function to test
function sum(a, b) {
  return a + b;
}

describe('sum function', () => {
  test('adds 1 + 2 to equal 3', () => {
    expect(sum(1, 2)).toBe(3);
  });

  test('adds -1 + 1 to equal 0', () => {
    expect(sum(-1, 1)).toBe(0);
  });
});

// You can add more describe blocks and test cases for different modules/functions.
// For example, if you have a module in 'src/utils.js':
// const utils = require('./src/utils');
// describe('My Utility Module', () => {
//   test('should perform some utility function correctly', () => {
//     expect(utils.myFunction()).toBe(expectedValue);
//   });
// });