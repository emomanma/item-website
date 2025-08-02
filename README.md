# 产品分析器

这是一个Web应用程序，允许用户通过手机或其他设备登录，使用设备摄像头拍照产品，按产品命名保存图片，调用Qwen API分析产品的名称、品牌、价格和条形码，并将所有产品信息导出为Excel文档。

## 功能

- 用户登录
- 访问设备摄像头
- 拍照并按产品命名保存
- 调用Qwen API分析产品信息
- 将产品信息导出为Excel文档

## 安装

1. 克隆或下载此仓库。
2. 在项目根目录下运行以下命令安装依赖：

```
npm install
```

## 配置

1. 在`server.js`文件中，将`your-qwen-api-key`替换为您的实际Qwen API密钥。

## 运行

1. 在项目根目录下运行以下命令启动服务器：

```
npm start
```

2. 打开浏览器并访问`http://localhost:3000`。

对于云部署，服务器端口将通过环境变量`PORT`配置，如果未设置则默认为3000。

## 使用

1. 使用用户名`admin`和密码`password`登录。
2. 允许浏览器访问摄像头。
3. 输入产品名称，点击"拍照"按钮拍照。
4. 点击"保存图片"按钮保存图片。
5. 重复步骤3和4以添加更多产品。
6. 点击"分析所有产品"按钮调用Qwen API分析产品信息。
7. 点击"导出Excel"按钮将产品信息导出为Excel文档。

## 部署

要将此应用部署为网页应用，您可以使用以下云平台之一：

### Vercel

1. 将项目推送到GitHub仓库。
2. 在[Vercel](https://vercel.com/)上注册或登录。
3. 点击"New Project"并导入您的GitHub仓库。
4. 在构建设置中，将构建命令设置为`npm run build`（如果有的话）或将输出目录设置为`public`。
5. 点击"Deploy"，Vercel将自动部署您的应用。

### Netlify

1. 将项目推送到GitHub仓库。
2. 在[Netlify](https://www.netlify.com/)上注册或登录。
3. 点击"New site from Git"并选择您的GitHub仓库。
4. 在部署设置中，将构建命令设置为`npm run build`（如果有的话）或将发布目录设置为`public`。
5. 点击"Deploy site"，Netlify将自动部署您的应用。

### GitHub Pages (无需登录第三方网站)

GitHub Pages 是 GitHub 提供的免费静态网站托管服务，您可以直接使用您的 GitHub 账号进行部署，无需注册其他服务。

1. 将项目推送到您的 GitHub 仓库。
2. 在仓库页面，点击 "Settings" 选项卡。
3. 向下滚动到 "Pages" 部分。
4. 在 "Source" 下拉菜单中选择 "GitHub Actions" 或 "master branch"/"main branch"（如果您的静态文件在主分支的根目录）。
5. 如果使用 GitHub Actions，创建一个工作流文件（例如 `.github/workflows/deploy.yml`）来构建和部署您的应用。一个简单的部署工作流示例：
   ```yaml
   name: Deploy to GitHub Pages
   
   on:
     push:
       branches: [ main ]
     
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v2
         
         - name: Setup Node.js
           uses: actions/setup-node@v2
           with:
             node-version: '14'
             
         - name: Install dependencies
           run: npm install
           
         - name: Build project (if necessary)
           run: npm run build
           
         - name: Deploy to GitHub Pages
           uses: peaceiris/actions-gh-pages@v3
           with:
             github_token: ${{ secrets.GITHUB_TOKEN }}
             publish_dir: ./public
   ```
6. 保存设置，GitHub Pages 将自动部署您的应用。
7. 部署完成后，您将在 "Pages" 部分看到您的网站 URL。

### 使用GitHub Actions自动部署

如果您希望使用GitHub Actions自动部署应用，请按照以下步骤操作：

1. 在您的GitHub仓库中，创建 `.github/workflows` 目录。
2. 在该目录中创建一个名为 `deploy.yml` 的文件。
3. 将以下内容添加到 `deploy.yml` 文件中：

   ```yaml
   name: Deploy to GitHub Pages

   on:
     push:
       branches: [ main ]
     workflow_dispatch:

   defaults:
     run:
       working-directory: .

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - name: Checkout
           uses: actions/checkout@v3

         - name: Setup Node.js
           uses: actions/setup-node@v3
           with:
             node-version: 16

         - name: Install dependencies
           run: npm install

         - name: Build
           run: |
             # 如果有构建步骤，请在这里添加
             echo "No build step required for this static site"

         - name: Deploy to GitHub Pages
           uses: peaceiris/actions-gh-pages@v3
           with:
             github_token: ${{ secrets.GITHUB_TOKEN }}
             publish_dir: .
             # 如果只想发布特定文件，可以使用以下选项
             # publish_dir: ./dist
   ```

4. 将您的代码推送到GitHub仓库的 `main` 分支。
5. GitHub Actions将自动运行工作流并将您的应用部署到GitHub Pages。

## 技术栈

- 前端：HTML5, CSS3, JavaScript (ES6+)
- 后端：Node.js, Express
- API：Qwen API
- 文件处理：xlsx库

## 注意事项

- 由于浏览器安全限制，摄像头访问需要在HTTPS环境下或本地开发环境（localhost）下才能正常工作。
- Qwen API调用需要有效的API密钥。
- 产品图片保存在浏览器的下载目录中。