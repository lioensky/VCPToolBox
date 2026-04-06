#!/bin/bash
# PaperReader 业务不变量校验脚本
# 用于 Codex CLI 或 CI/CD 流程

set -e

echo "=========================================="
echo "PaperReader Business Invariant Check"
echo "=========================================="

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查工作目录
cd "$(dirname "$0")/.."

echo ""
echo "Step 1: Running cargo check..."
echo "------------------------------------------"
if cargo check --workspace 2>&1; then
    echo -e "${GREEN}✓ cargo check passed${NC}"
else
    echo -e "${RED}✗ cargo check failed${NC}"
    exit 1
fi

echo ""
echo "Step 2: Running cargo clippy..."
echo "------------------------------------------"
if cargo clippy --workspace -- -D warnings 2>&1 | head -50; then
    echo -e "${GREEN}✓ cargo clippy passed${NC}"
else
    echo -e "${YELLOW}⚠ cargo clippy found warnings (non-blocking)${NC}"
fi

echo ""
echo "Step 3: Running cargo test..."
echo "------------------------------------------"
if cargo test --workspace 2>&1; then
    echo -e "${GREEN}✓ cargo test passed${NC}"
else
    echo -e "${RED}✗ cargo test failed${NC}"
    exit 1
fi

echo ""
echo "Step 4: Running invariant-specific tests..."
echo "------------------------------------------"

# Domain层不变量测试
echo "Testing domain invariants..."
if cargo test -p paperreader-domain invariants 2>&1 | grep -q "test result: ok"; then
    echo -e "${GREEN}✓ Domain invariants passed${NC}"
else
    echo -e "${RED}✗ Domain invariants failed${NC}"
    exit 1
fi

# Workspace层不变量测试
echo "Testing workspace invariants..."
if cargo test -p paperreader-workspace invariants 2>&1 | grep -q "test result: ok"; then
    echo -e "${GREEN}✓ Workspace invariants passed${NC}"
else
    echo -e "${RED}✗ Workspace invariants failed${NC}"
    exit 1
fi

echo ""
echo "Step 5: Checking for critical code patterns..."
echo "------------------------------------------"

# 检查 unwrap() 和 expect() 的使用
UNWRAP_COUNT=$(grep -r "unwrap()" crates/*/src/*.rs 2>/dev/null | wc -l)
EXPECT_COUNT=$(grep -r "expect(" crates/*/src/*.rs 2>/dev/null | wc -l)

echo "Found $UNWRAP_COUNT unwrap() calls"
echo "Found $EXPECT_COUNT expect() calls"

if [ "$UNWRAP_COUNT" -gt 10 ]; then
    echo -e "${YELLOW}⚠ High number of unwrap() calls - consider error handling${NC}"
else
    echo -e "${GREEN}✓ unwrap() usage is reasonable${NC}"
fi

echo ""
echo "Step 6: Verifying public API documentation..."
echo "------------------------------------------"

# 检查缺失文档的公共项
MISSING_DOC=$(cargo doc --workspace 2>&1 | grep -c "missing" || true)
if [ "$MISSING_DOC" -eq 0 ]; then
    echo -e "${GREEN}✓ No missing documentation warnings${NC}"
else
    echo -e "${YELLOW}⚠ Found $MISSING_DOC documentation warnings${NC}"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}All invariant checks passed!${NC}"
echo "=========================================="
