const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const xlsx = require('xlsx');

// 中间件
app.use(express.static('.'));
app.use(express.json({ limit: '10mb' }));

// Qwen API配置
const QWEN_API_KEY = 'sk-b82cd28c1d6e4c46be050d5c12b20578';
const QWEN_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

// 模拟Qwen API调用
async function callQwenAPI(imageData) {
    // 这里应该实现实际的Qwen API调用
    // 由于这是一个模拟，我们将返回一些示例数据
    return {
        name: '示例产品',
        brand: '示例品牌',
        price: '￥99.99',
        barcode: '1234567890123'
    };
}

// 分析产品路由
app.post('/analyze', async (req, res) => {
    try {
        const { products } = req.body;
        const analyzedProducts = [];

        for (const product of products) {
            // 这里应该读取实际的图片文件并转换为base64
            // 由于这是一个模拟，我们将使用空字符串
            const imageData = '';
            const result = await callQwenAPI(imageData);
            analyzedProducts.push({
                ...product,
                ...result
            });
        }

        res.json({ products: analyzedProducts });
    } catch (error) {
        console.error('Error analyzing products:', error);
        res.status(500).json({ error: 'Failed to analyze products' });
    }
});

// 导出Excel路由
app.get('/export', (req, res) => {
    try {
        const products = [
            { name: '示例产品1', brand: '品牌1', price: '￥99.99', barcode: '1234567890123' },
            { name: '示例产品2', brand: '品牌2', price: '￥199.99', barcode: '1234567890124' }
        ];

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(products);
        xlsx.utils.book_append_sheet(wb, ws, 'Products');
        const fileName = 'products.xlsx';
        xlsx.writeFile(wb, fileName);

        res.download(fileName);
    } catch (error) {
        console.error('Error exporting products:', error);
        res.status(500).json({ error: 'Failed to export products' });
    }
});

// 启动服务器
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});