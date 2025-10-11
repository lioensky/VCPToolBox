# B站（Bilibili）Cookies 配置指南

## 快速配置

### 🚀 方式一：一键粘贴（最简单，推荐！）

**步骤 1：复制所有 Cookies**

1. 在浏览器中登录 B站 (https://www.bilibili.com)
2. 按 `F12` 打开开发者工具
3. 切换到 **Console**（控制台）标签
4. 粘贴并运行以下代码：

```javascript
copy(document.cookie)
```

5. 此时所有 cookies 已复制到剪贴板！

**步骤 2：直接粘贴到配置文件**

在 `Plugin/UrlFetch/config.env` 中添加：

```env
FETCH_COOKIES_RAW=你粘贴的完整cookie字符串
```

**实际示例**：
```env
FETCH_COOKIES_RAW=SESSDATA=abc123def456; bili_jct=xyz789; DedeUserID=12345; buvid3=uuid-here
```

✅ **就这么简单！所有 cookies 一次性搞定，不需要手动提取单个值。**

---

### 📋 方式二：手动配置（适合高级用户）

**步骤 1：获取 B站 Cookies**

1. 在浏览器中登录 B站 (https://www.bilibili.com)
2. 按 `F12` 打开开发者工具
3. 切换到 **Application**（应用程序）标签
   - Chrome/Edge: Application → Storage → Cookies → https://www.bilibili.com
   - Firefox: 存储 → Cookie → https://www.bilibili.com
4. 找到以下关键 cookies 并复制它们的值：

| Cookie 名称 | 说明 | 必需性 |
|------------|------|--------|
| `SESSDATA` | 登录凭证（最重要） | ✅ 必需 |
| `bili_jct` | CSRF Token | ✅ 推荐 |
| `DedeUserID` | 用户 ID | ⚠️ 可选 |
| `buvid3` | 设备标识 | ⚠️ 可选 |

**步骤 2：配置到 config.env**

在 `Plugin/UrlFetch/config.env` 中添加：

#### 最简配置（仅 SESSDATA）
```env
FETCH_COOKIES=[{"name":"SESSDATA","value":"你的SESSDATA值","domain":".bilibili.com"}]
```

#### 推荐配置（SESSDATA + bili_jct）
```env
FETCH_COOKIES=[{"name":"SESSDATA","value":"你的SESSDATA值","domain":".bilibili.com"},{"name":"bili_jct","value":"你的bili_jct值","domain":".bilibili.com"}]
```

#### 完整配置（所有关键 cookies）
```env
FETCH_COOKIES=[{"name":"SESSDATA","value":"你的SESSDATA值","domain":".bilibili.com"},{"name":"bili_jct","value":"你的bili_jct值","domain":".bilibili.com"},{"name":"DedeUserID","value":"你的DedeUserID值","domain":".bilibili.com"},{"name":"buvid3","value":"你的buvid3值","domain":".bilibili.com"}]
```

### 步骤 3：验证配置

测试访问个人空间或需要登录的页面：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」UrlFetch「末」,
url:「始」https://space.bilibili.com/你的UID「末」
<<<[END_TOOL_REQUEST]>>>
```

## 详细说明

### Cookie 获取图文步骤

1. **登录 B站**
   - 访问 https://www.bilibili.com
   - 使用账号密码登录（或扫码登录）

2. **打开开发者工具**
   - Windows/Linux: 按 `F12` 或 `Ctrl+Shift+I`
   - Mac: 按 `Cmd+Option+I`

3. **定位 Cookies**
   ```
   Application（应用程序）
   └─ Storage（存储）
      └─ Cookies
         └─ https://www.bilibili.com
            ├─ SESSDATA ← 复制这个值
            ├─ bili_jct ← 复制这个值
            ├─ DedeUserID ← 可选
            └─ buvid3 ← 可选
   ```

4. **复制 Cookie 值**
   - 双击 Cookie 的 Value 列
   - 按 `Ctrl+C` 复制
   - 粘贴到配置文件中

### 配置示例（真实格式）

假设你获取到的 cookies 是：
- SESSDATA: `abc123def456ghi789jkl`
- bili_jct: `xyz789uvw456rst`

那么配置应该写成：

```env
FETCH_COOKIES=[{"name":"SESSDATA","value":"abc123def456ghi789jkl","domain":".bilibili.com"},{"name":"bili_jct","value":"xyz789uvw456rst","domain":".bilibili.com"}]
```

⚠️ **注意**：
- 不要有换行
- 确保 JSON 格式正确
- `domain` 必须是 `.bilibili.com`（注意前面的点）
- 引号必须使用英文双引号 `"`

### 使用场景

配置好 cookies 后，可以访问：

1. **个人空间**
   ```text
   url:「始」https://space.bilibili.com/你的UID「末」
   ```

2. **收藏夹**
   ```text
   url:「始」https://space.bilibili.com/你的UID/favlist「末」
   ```

3. **关注列表**
   ```text
   url:「始」https://space.bilibili.com/你的UID/fans/follow「末」
   ```

4. **稍后再看**
   ```text
   url:「始」https://www.bilibili.com/watchlater/「末」
   ```

5. **历史记录**
   ```text
   url:「始」https://www.bilibili.com/account/history「末」
   ```

## 常见问题

### Q: SESSDATA 在哪里？

A: 在开发者工具的 Cookies 列表中，通常在靠前的位置。它的值是一个很长的字符串（30-40 个字符）。

### Q: 配置后还是显示未登录？

A: 检查以下几点：
1. SESSDATA 是否复制完整（没有多余空格或换行）
2. `domain` 是否写成 `.bilibili.com`（注意前面有个点）
3. Cookie 是否已过期（重新登录获取新的）
4. JSON 格式是否正确（使用在线 JSON 校验器检查）

### Q: Cookie 会过期吗？

A: 会的。B站的 SESSDATA 通常有效期为：
- 登录时选择"记住我"：约 30 天
- 未选择"记住我"：关闭浏览器后失效

如果失效了，需要重新登录并获取新的 SESSDATA。

### Q: 安全性如何？

A: ⚠️ **重要提示**：
- SESSDATA 相当于你的登录凭证
- 不要分享给他人
- 不要提交到公开的代码仓库
- 建议定期更换（重新登录）
- `config.env` 文件已在 `.gitignore` 中，不会被 git 追踪

### Q: 可以同时配置多个网站的 cookies 吗？

A: 可以！推荐使用 `FETCH_COOKIES_RAW_MULTI` 多站点配置：

**示例**（B站 + Twitter + GitHub）：
```env
FETCH_COOKIES_RAW_MULTI={"bilibili.com":"SESSDATA=xxx; bili_jct=yyy; DedeUserID=zzz","twitter.com":"auth_token=aaa; ct0=bbb","github.com":"user_session=ccc"}
```

**使用方法**：
1. 在 B站登录后，Console 运行 `copy(document.cookie)` 获取 B站 cookies
2. 在 Twitter 登录后，同样方式获取 Twitter cookies
3. 在 GitHub 登录后，同样方式获取 GitHub cookies
4. 按上面格式组合到一起

之后访问任何网站都会自动使用对应的 cookies！

**或使用 JSON 数组格式**：
```env
FETCH_COOKIES=[{"name":"SESSDATA","value":"B站的值","domain":".bilibili.com"},{"name":"auth_token","value":"Twitter的值","domain":".twitter.com"}]
```

## 高级技巧

### 1. 快速复制所有 Cookies（推荐）

在 B站页面的开发者工具 Console（控制台）中运行：

```javascript
// 一键复制所有 cookies
copy(document.cookie)
```

然后直接粘贴到 `FETCH_COOKIES_RAW` 配置中。

### 2. 提取为 JSON 格式（高级用户）

```javascript
// 提取关键 cookies 为 JSON 格式
const cookies = document.cookie.split('; ').reduce((acc, cookie) => {
  const [name, value] = cookie.split('=');
  if (['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3'].includes(name)) {
    acc.push({name, value, domain: '.bilibili.com'});
  }
  return acc;
}, []);

console.log(JSON.stringify(cookies));
```

复制输出结果用于 `FETCH_COOKIES` 配置。

### 3. 同时配置多个网站

**B站 + Twitter + GitHub 示例**：

```env
FETCH_COOKIES_RAW_MULTI={"bilibili.com":"SESSDATA=xxx; bili_jct=yyy","twitter.com":"auth_token=aaa; ct0=bbb","github.com":"user_session=ccc"}
```

访问任何已配置的网站都会自动使用对应的 cookies！

### 4. 批量配置多个账号（同一网站）

如果需要切换不同 B站账号，可以准备多个配置：

```env
# 账号1（当前使用）
FETCH_COOKIES_RAW_MULTI={"bilibili.com":"SESSDATA=账号1的cookies"}

# 账号2
#FETCH_COOKIES_RAW_MULTI={"bilibili.com":"SESSDATA=账号2的cookies"}

# 或单站点格式
#FETCH_COOKIES_RAW=SESSDATA=账号2的cookie字符串; bili_jct=yyy
```

需要切换时，只需注释/取消注释对应行。

## 测试清单

配置完成后，依次测试：

- [ ] 访问首页 `https://www.bilibili.com`
- [ ] 访问个人空间 `https://space.bilibili.com/你的UID`
- [ ] 访问稍后再看 `https://www.bilibili.com/watchlater/`
- [ ] 检查返回内容是否包含个人信息

如果以上测试都通过，说明配置成功！