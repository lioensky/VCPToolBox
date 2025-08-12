# ImageServer 插件 (图床服务)

这是一个简单的插件，用于提供一个受密码保护的静态图片服务。

## 功能

*   通过 HTTP 提供项目根目录下 `image/` 文件夹中的静态图片。
*   使用配置的 `Image_Key` 对访问进行密码保护。

## 配置

此插件需要在其配置中设置一个 `Image_Key` 字段。这个 Key 将作为访问图片服务的密码。

```json
{
  "Image_Key": "your_secret_password_here"
}
```

请将 `"your_secret_password_here"` 替换为您自己的安全密码。

## 使用方法

配置并启用插件后，可以通过以下格式的 URL 访问 `image/` 目录下的图片：

`http://<your-server-address>:<port>/pw=<Your_Image_Key>/images/<image_filename>`

**示例:**

假设您的服务运行在 `http://localhost:8080`，您配置的 `Image_Key` 是 `mysecretkey`，并且您想访问位于项目根目录下 `image/cat.png` 的图片，那么 URL 将是：

`http://localhost:8080/pw=mysecretkey/images/cat.png`

## 注意

*   **必须** 在插件配置中设置 `Image_Key`。如果未设置，服务将无法正常工作，并且所有访问请求都会被拒绝。
*   确保项目根目录下存在一个名为 `image` 的文件夹，并将您希望通过此服务提供的图片放入该文件夹中。