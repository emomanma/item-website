const express = require('express');
const https = require('https');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const XLSX = require('xlsx');
const selfsigned = require('selfsigned');

const app = express();
const PORT = process.env.PORT || 3443;

// 创建uploads目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// 创建自签名证书（仅在本地开发时使用）
let httpsOptions = null;

if (process.env.NODE_ENV !== 'production') {
    const attrs = [{ name: 'commonName', value: '192.168.15.122' }];
    const pems = selfsigned.generate(attrs, { 
        keySize: 2048, 
        days: 365,
        algorithm: 'sha256',
        extensions: [{
            name: 'basicConstraints',
            cA: true,
        }, {
            name: 'keyUsage',
            keyCertSign: true,
            digitalSignature: true,
            nonRepudiation: true,
            keyEncipherment: true,
            dataEncipherment: true,
        }, {
            name: 'subjectAltName',
            altNames: [{
                type: 2, // DNS
                value: 'localhost',
            }, {
                type: 7, // IP
                ip: '192.168.15.122',
            }, {
                type: 7, // IP
                ip: '127.0.0.1',
            }]
        }]
    });

    httpsOptions = {
        key: pems.private,
        cert: pems.cert
    };
}

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('.'));

// 配置文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueId = uuidv4();
        const extension = path.extname(file.originalname);
        cb(null, uniqueId + extension);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB限制
});

// 千问API配置
const QWEN_API_KEY = 'sk-b82cd28c1d6e4c46be050d5c12b20578';
const QWEN_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

// ===========================================
// 并发控制和文件锁机制
// ===========================================

// 文件锁管理器
class FileLockManager {
    constructor() {
        this.locks = new Map();
        this.queue = new Map();
    }

    async acquireLock(filePath, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const lockKey = filePath;
            
            if (!this.locks.has(lockKey)) {
                // 没有锁，直接获取
                this.locks.set(lockKey, true);
                resolve();
                return;
            }

            // 有锁，加入队列
            if (!this.queue.has(lockKey)) {
                this.queue.set(lockKey, []);
            }

            const timeoutId = setTimeout(() => {
                // 超时处理
                const queue = this.queue.get(lockKey) || [];
                const index = queue.findIndex(item => item.resolve === resolve);
                if (index !== -1) {
                    queue.splice(index, 1);
                }
                reject(new Error('文件锁获取超时'));
            }, timeout);

            this.queue.get(lockKey).push({ resolve, reject, timeoutId });
        });
    }

    releaseLock(filePath) {
        const lockKey = filePath;
        
        if (!this.locks.has(lockKey)) {
            return;
        }

        this.locks.delete(lockKey);

        // 处理队列中的下一个请求
        const queue = this.queue.get(lockKey);
        if (queue && queue.length > 0) {
            const next = queue.shift();
            clearTimeout(next.timeoutId);
            this.locks.set(lockKey, true);
            next.resolve();
        }
    }
}

const fileLockManager = new FileLockManager();

// 产品数据文件管理
const PRODUCTS_FILE = path.join(__dirname, 'products-concurrent.json');

// 安全的文件读写操作
async function safeReadProducts() {
    await fileLockManager.acquireLock(PRODUCTS_FILE);
    
    try {
        if (fs.existsSync(PRODUCTS_FILE)) {
            const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            
            if (Array.isArray(parsed)) {
                return parsed;
            } else if (parsed && Array.isArray(parsed.products)) {
                console.log('检测到旧格式数据，正在转换...');
                const products = parsed.products;
                await safeSaveProducts(products);
                return products;
            } else {
                console.error('产品数据文件格式错误，不是数组类型:', typeof parsed);
                const backupFile = PRODUCTS_FILE + '.backup.' + Date.now();
                fs.writeFileSync(backupFile, data);
                console.log('已备份损坏的文件到:', backupFile);
                return [];
            }
        }
        return [];
    } catch (error) {
        console.error('读取产品数据失败:', error);
        return [];
    } finally {
        fileLockManager.releaseLock(PRODUCTS_FILE);
    }
}

async function safeSaveProducts(products) {
    await fileLockManager.acquireLock(PRODUCTS_FILE);
    
    try {
        // 创建临时文件
        const tempFile = PRODUCTS_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(products, null, 2));
        
        // 原子操作：重命名临时文件
        fs.renameSync(tempFile, PRODUCTS_FILE);
        
        console.log('产品数据已安全保存');
    } catch (error) {
        console.error('保存产品数据失败:', error);
        throw error;
    } finally {
        fileLockManager.releaseLock(PRODUCTS_FILE);
    }
}

// 请求限流器
class RateLimiter {
    constructor(maxRequests = 10, windowMs = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.requests = new Map();
    }

    isAllowed(clientId) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        if (!this.requests.has(clientId)) {
            this.requests.set(clientId, []);
        }

        const clientRequests = this.requests.get(clientId);
        
        // 清理过期请求
        while (clientRequests.length > 0 && clientRequests[0] < windowStart) {
            clientRequests.shift();
        }

        if (clientRequests.length >= this.maxRequests) {
            return false;
        }

        clientRequests.push(now);
        return true;
    }
}

const rateLimiter = new RateLimiter(20, 60000); // 每分钟最多20个请求

// 中间件：限流
app.use((req, res, next) => {
    const clientId = req.ip || 'unknown';
    
    if (!rateLimiter.isAllowed(clientId)) {
        return res.status(429).json({
            success: false,
            error: '请求过于频繁，请稍后再试'
        });
    }
    
    next();
});

// ===========================================
// AI分析相关函数（保持原有逻辑）
// ===========================================

function imageToBase64(imagePath) {
    try {
        // 处理不同的路径格式
        let fullPath;
        
        if (imagePath.startsWith('/uploads/')) {
            // 处理 /uploads/ 开头的路径
            fullPath = path.join(__dirname, imagePath);
        } else if (imagePath.startsWith('uploads/')) {
            // 处理 uploads/ 开头的路径
            fullPath = path.join(__dirname, imagePath);
        } else if (path.isAbsolute(imagePath)) {
            // 绝对路径
            fullPath = imagePath;
        } else {
            // 相对路径，假设在 uploads 目录下
            fullPath = path.join(__dirname, 'uploads', imagePath);
        }
        
        console.log(`处理图片路径: ${imagePath} -> ${fullPath}`);
        
        if (!fs.existsSync(fullPath)) {
            console.error('图片文件不存在:', fullPath);
            return null;
        }
        
        // 检测图片格式
        const ext = path.extname(fullPath).toLowerCase();
        let mimeType = 'image/jpeg'; // 默认
        
        switch (ext) {
            case '.jpg':
            case '.jpeg':
                mimeType = 'image/jpeg';
                break;
            case '.png':
                mimeType = 'image/png';
                break;
            case '.gif':
                mimeType = 'image/gif';
                break;
            case '.webp':
                mimeType = 'image/webp';
                break;
            default:
                mimeType = 'image/jpeg';
        }
        
        const imageBuffer = fs.readFileSync(fullPath);
        const base64String = imageBuffer.toString('base64');
        
        console.log(`图片转换成功，格式: ${mimeType}, Base64长度: ${base64String.length}`);
        return { base64: base64String, mimeType: mimeType };
        
    } catch (error) {
        console.error('转换图片为Base64失败:', error);
        return null;
    }
}

async function analyzeImageWithQwen(imagePaths, photoCount) {
    const models = [
        'qwen-vl-plus',
        'qwen-vl-max',
        'qwen-vl-v1',
        'qwen-plus',
        'qwen-turbo',
        'qwen-max'
    ];

    console.log(`🚀 开始AI分析，尝试 ${models.length} 个模型...`);

    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        console.log(`📡 尝试模型 ${i + 1}/${models.length}: ${model}`);
        
        try {
            const result = await analyzeWithModel(model, imagePaths, photoCount);
            console.log(`✅ 模型 ${model} 分析成功!`);
            return result;
        } catch (error) {
            console.error(`❌ 模型 ${model} 分析失败:`, error.message);
            
            if (model !== models[models.length - 1]) {
                console.log(`🔄 尝试下一个模型...`);
                continue;
            }
        }
    }
    
    console.error('所有模型都分析失败');
    return {
        success: false,
        error: '所有可用模型都分析失败',
        data: {
            name: '分析失败',
            brand: '分析失败', 
            price: '分析失败',
            barcode: '分析失败'
        }
    };
}

async function analyzeWithModel(model, imagePaths, photoCount) {
    try {
        const systemPrompt = '你是一个专业的条形码和产品信息识别专家。你必须极其仔细地分析图片中的每个细节，专门寻找条形码数字和产品信息。';
        
        const analysisPrompt = `🎯 **专业条形码和产品识别任务**

我需要你极其仔细地检查这${photoCount}张产品图片中的每一个细节，识别产品信息和条形码。

**🔍 条形码识别策略**：

1. **详细检查区域**：
   - 产品包装底部（90%的条形码在这里）
   - 产品包装背面
   - 产品包装侧面
   - 任何标签或贴纸
   - 包装盒的接缝处
   - 产品包装的每个角落

2. **条形码视觉特征**：
   - 黑白相间的垂直线条（条纹图案）
   - 条纹下方的数字序列
   - 数字通常是12-13位
   - 可能分组显示：123 4567 8901 2
   - 字体较小，通常是黑色

3. **扩展搜索规则**：
   - 寻找任何6位以上的连续数字
   - 查找产品编号、序列号
   - 注意"条形码"、"barcode"、"Code"等标识
   - 即使数字模糊也要尝试识别
   - 即使只能看到部分数字也要记录

4. **产品信息识别**：
   - 产品名称：包装正面的主要文字
   - 品牌名称：logo或品牌标识
   - 价格信息：价格标签、标价
   - 产品描述：包装上的详细信息

**⚠️ 特别指令**：
- 这是条形码专门识别任务，条形码是最重要的！
- 宁可记录可疑的数字序列也不要遗漏
- 仔细查看图片的每个像素
- 如果看到任何长数字都要记录
- 真的找不到任何数字才说"未识别"

**📝 其他信息**（次要）：
- 产品名称
- 品牌名称
- 价格信息

**严格按JSON格式返回**：
{"name": "产品名称", "brand": "品牌", "price": "价格", "barcode": "条形码数字或任何数字序列"}

现在开始极其仔细地分析这些图片！`;

        const messageContent = [];
        
        messageContent.push({
            "text": analysisPrompt
        });

        for (const imagePath of imagePaths) {
            const imageData = imageToBase64(imagePath);
            if (imageData) {
                messageContent.push({
                    "image": `data:${imageData.mimeType};base64,${imageData.base64}`
                });
            }
        }

        if (messageContent.length === 1) {
            throw new Error('没有可用的图片数据');
        }

        const requestData = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "system",
                        "content": [
                            {
                                "text": systemPrompt
                            }
                        ]
                    },
                    {
                        "role": "user",
                        "content": messageContent
                    }
                ]
            },
            "parameters": {
                "result_format": "message"
            }
        };

        console.log(`发送请求到Qwen API (${model})...`);
        
        const response = await axios.post(QWEN_API_URL, requestData, {
            headers: {
                'Authorization': `Bearer ${QWEN_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log(`Qwen API响应状态 (${model}):`, response.status);

        if (response.data && response.data.output && response.data.output.choices) {
            const choice = response.data.output.choices[0];
            let content = '';
            
            if (choice.message && choice.message.content) {
                if (Array.isArray(choice.message.content)) {
                    content = choice.message.content.map(item => {
                        if (typeof item === 'string') return item;
                        if (item && typeof item.text === 'string') return item.text;
                        return '';
                    }).join('');
                } else if (typeof choice.message.content === 'string') {
                    content = choice.message.content;
                } else {
                    content = String(choice.message.content || '');
                }
            } else {
                throw new Error(`API响应格式异常 (${model})`);
            }
            
            // 确保content是字符串
            if (typeof content !== 'string') {
                content = String(content || '');
            }
            
            console.log(`AI分析结果 (${model}):`, content);

            try {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    
                    const cleanResult = {
                        name: (parsedResult.name || '').replace(/[""]/g, '').trim(),
                        brand: (parsedResult.brand || '').replace(/[""]/g, '').trim(),
                        price: (parsedResult.price || '').replace(/[""]/g, '').trim(),
                        barcode: (parsedResult.barcode || '').replace(/[""]/g, '').trim()
                    };

                    if (cleanResult.barcode && !/^\d{8,18}$/.test(cleanResult.barcode.replace(/\s/g, ''))) {
                        console.log('条形码格式可能有问题，保持原样:', cleanResult.barcode);
                    }

                    console.log(`解析后的结果 (${model}):`, cleanResult);
                    return { success: true, data: cleanResult };
                }
            } catch (parseError) {
                console.error(`JSON解析失败 (${model}):`, parseError);
            }

            console.log(`尝试文本解析 (${model})...`);
            
            // 严格检查 content 是否为有效字符串
            if (!content || typeof content !== 'string' || content.trim() === '') {
                console.error(`Content为空或无效 (${model}):`, typeof content, content);
                throw new Error(`无效的API响应内容 (${model})`);
            }
            
            // 确保content是字符串
            const contentStr = String(content).trim();
            
            if (!contentStr) {
                throw new Error(`API响应内容为空 (${model})`);
            }
            
            const result = {
                name: extractInfo(contentStr, ['产品名称', '名称', 'name']) || '未识别',
                brand: extractInfo(contentStr, ['品牌', 'brand']) || '未识别',
                price: extractInfo(contentStr, ['价格', 'price']) || '未识别',
                barcode: extractInfo(contentStr, ['条形码', 'barcode']) || '未识别'
            };

            return { success: true, data: result };
        }

        throw new Error(`API响应格式异常 (${model})`);

    } catch (error) {
        console.error(`AI分析失败 (${model}):`, error.message);
        
        if (error.response) {
            console.error(`API错误响应 (${model}):`, error.response.status, error.response.data);
        }

        // 确保不会有其他地方抛出 text.match 错误
        const safeError = new Error(`模型 ${model} 分析失败: ${error.message || '未知错误'}`);
        throw safeError;
    }
}

function extractInfo(text, keywords) {
    // 严格的类型检查和转换
    if (text === null || text === undefined) {
        console.log('extractInfo: text is null or undefined');
        return null;
    }
    
    if (typeof text !== 'string') {
        console.log('extractInfo: converting non-string to string:', typeof text);
        try {
            text = String(text);
        } catch (error) {
            console.error('extractInfo: failed to convert to string:', error);
            return null;
        }
    }
    
    if (!text || !text.trim()) {
        console.log('extractInfo: text is empty after trim');
        return null;
    }
    
    // 验证 keywords 数组
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        console.log('extractInfo: invalid keywords array');
        return null;
    }
    
    try {
        for (const keyword of keywords) {
            if (!keyword || typeof keyword !== 'string') {
                console.log('extractInfo: skipping invalid keyword:', keyword);
                continue;
            }
            
            const regex = new RegExp(`${keyword}[：:]+\\s*([^\\n,，。]+)`, 'i');
            const match = text.match(regex);
            if (match && match[1]) {
                const result = match[1].trim().replace(/["""]/g, '');
                console.log(`extractInfo: found ${keyword} -> ${result}`);
                return result;
            }
        }
    } catch (error) {
        console.error('extractInfo: regex error:', error, 'text type:', typeof text, 'text length:', text ? text.length : 'N/A');
        return null;
    }
    
    return null;
}

// ===========================================
// API路由定义
// ===========================================

// 图片上传接口
app.post('/upload-image', upload.single('image'), (req, res) => {
    console.log('收到图片上传请求');
    
    if (!req.file) {
        console.error('未收到图片文件');
        return res.status(400).json({ success: false, error: '未收到图片文件' });
    }

    console.log('图片上传成功:', req.file.filename);
    
    const imagePath = `/uploads/${req.file.filename}`;
    res.json({ 
        success: true, 
        imagePath: imagePath,
        filename: req.file.filename 
    });
});

// AI分析接口
app.post('/analyze', async (req, res) => {
    try {
        console.log('收到AI分析请求');
        const { imagePaths, photoCount } = req.body;

        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: '缺少图片路径或图片路径格式错误' 
            });
        }

        console.log(`开始分析 ${imagePaths.length} 张图片`);

        const analysisResult = await analyzeImageWithQwen(imagePaths, photoCount || imagePaths.length);

        if (analysisResult && analysisResult.success) {
            res.json(analysisResult);
        } else {
            // 确保返回的错误信息是安全的
            const errorMessage = (analysisResult && analysisResult.error) ? String(analysisResult.error) : '未知分析错误';
            
            res.status(500).json({
                success: false,
                error: errorMessage,
                data: {
                    name: '分析失败',
                    brand: '分析失败',
                    price: '分析失败',
                    barcode: '分析失败'
                }
            });
        }

    } catch (error) {
        console.error('分析请求处理失败:', error);
        
        // 确保错误信息是字符串
        const errorMessage = error && error.message ? String(error.message) : '服务器内部错误';
        
        res.status(500).json({
            success: false,
            error: errorMessage,
            data: {
                name: '分析失败',
                brand: '分析失败',
                price: '分析失败',
                barcode: '分析失败'
            }
        });
    }
});

// 保存产品接口
app.post('/save-product', async (req, res) => {
    try {
        console.log('收到保存产品请求');
        const { name, brand, price, barcode, description, imagePaths } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: '产品名称不能为空' 
            });
        }

        const products = await safeReadProducts();
        
        const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const todayProducts = products.filter(p => p.serialNumber.startsWith(today));
        const serialNumber = `${today}${String(todayProducts.length + 1).padStart(3, '0')}`;

        const newProduct = {
            id: uuidv4(),
            serialNumber,
            name: name.trim(),
            brand: brand ? brand.trim() : '',
            price: price ? price.trim() : '',
            barcode: barcode ? barcode.trim() : '',
            description: description ? description.trim() : '',
            imagePaths: imagePaths || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        products.push(newProduct);
        await safeSaveProducts(products);

        console.log('产品保存成功:', serialNumber);
        res.json({ 
            success: true, 
            serialNumber,
            productId: newProduct.id 
        });

    } catch (error) {
        console.error('保存产品失败:', error);
        res.status(500).json({
            success: false,
            error: '保存失败: ' + error.message
        });
    }
});

// 获取产品列表接口
app.get('/products', async (req, res) => {
    try {
        console.log('收到获取产品列表请求');
        const products = await safeReadProducts();
        
        if (!Array.isArray(products)) {
            console.error('产品数据不是数组类型:', typeof products, products);
            throw new Error('产品数据格式错误，不是数组类型');
        }
        
        products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            success: true,
            products,
            total: products.length
        });

    } catch (error) {
        console.error('获取产品列表失败:', error);
        res.status(500).json({
            success: false,
            error: '获取产品列表失败: ' + error.message
        });
    }
});

// 删除产品接口
app.delete('/products/:id', async (req, res) => {
    try {
        console.log('收到删除产品请求:', req.params.id);
        const products = await safeReadProducts();
        const index = products.findIndex(p => p.id === req.params.id);

        if (index === -1) {
            return res.status(404).json({
                success: false,
                error: '产品不存在'
            });
        }

        const deletedProduct = products.splice(index, 1)[0];
        await safeSaveProducts(products);

        if (deletedProduct.imagePaths) {
            deletedProduct.imagePaths.forEach(imagePath => {
                const fullPath = path.join(__dirname, imagePath);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                }
            });
        }

        console.log('产品删除成功:', deletedProduct.serialNumber);
        res.json({ success: true });

    } catch (error) {
        console.error('删除产品失败:', error);
        res.status(500).json({
            success: false,
            error: '删除失败: ' + error.message
        });
    }
});

// Excel导出接口
app.get('/export-excel', async (req, res) => {
    try {
        console.log('收到Excel导出请求');
        const products = await safeReadProducts();

        if (products.length === 0) {
            return res.status(404).json({
                success: false,
                error: '没有产品数据可导出'
            });
        }

        const excelData = products.map((product, index) => ({
            '序号': index + 1,
            '产品序列号': product.serialNumber,
            '产品名称': product.name,
            '品牌': product.brand,
            '价格': product.price,
            '条形码': product.barcode,
            '描述': product.description,
            '图片数量': product.imagePaths ? product.imagePaths.length : 0,
            '创建时间': new Date(product.createdAt).toLocaleString('zh-CN')
        }));

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(excelData);

        ws['!cols'] = [
            { wch: 8 },   // 序号
            { wch: 15 },  // 产品序列号
            { wch: 25 },  // 产品名称
            { wch: 15 },  // 品牌
            { wch: 12 },  // 价格
            { wch: 18 },  // 条形码
            { wch: 30 },  // 描述
            { wch: 10 },  // 图片数量
            { wch: 20 }   // 创建时间
        ];

        XLSX.utils.book_append_sheet(wb, ws, '产品列表');

        const filename = `产品列表_${new Date().toISOString().split('T')[0]}.xlsx`;
        
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.send(buffer);

        console.log('Excel导出成功');

    } catch (error) {
        console.error('Excel导出失败:', error);
        res.status(500).json({
            success: false,
            error: 'Excel导出失败: ' + error.message
        });
    }
});

// 系统状态接口（新增）
app.get('/system-status', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        version: '6.1 - 并发支持版',
        concurrent_users: '最多3人同时使用',
        timestamp: new Date().toISOString(),
        memory_usage: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// 启动服务器
let server;

if (process.env.NODE_ENV === 'production') {
    // 生产环境使用HTTP（云平台会提供HTTPS）
    server = app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('🚀 智能产品收集系统 v6.1 (云端部署版) 启动成功！');
        console.log('');
        console.log('📊 系统信息:');
        console.log(`   端口: ${PORT}`);
        console.log(`   协议: HTTP (云平台提供HTTPS)`);
        console.log(`   环境: 生产环境`);
        console.log(`   并发支持: 最多3人同时使用`);
        console.log(`   文件锁: 已启用`);
        console.log(`   限流保护: 已启用`);
        console.log('');
        console.log('✨ 云端功能:');
        console.log('   - 公网访问支持');
        console.log('   - 自动HTTPS证书');
        console.log('   - 持久化存储');
        console.log('   - 全球CDN加速');
        console.log('');
    });
} else {
    // 开发环境使用HTTPS
    server = https.createServer(httpsOptions, app);
    
    server.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('🚀 智能产品收集系统 v6.1 (本地开发版) 启动成功！');
        console.log('');
        console.log('📊 系统信息:');
        console.log(`   端口: ${PORT}`);
        console.log(`   协议: HTTPS (自签名证书)`);
        console.log(`   环境: 开发环境`);
        console.log(`   并发支持: 最多3人同时使用`);
        console.log(`   文件锁: 已启用`);
        console.log(`   限流保护: 已启用`);
        console.log('');
        console.log('🌐 本地访问地址:');
        console.log(`   https://localhost:${PORT}/batch-system.html`);
        console.log(`   https://127.0.0.1:${PORT}/batch-system.html`);
        console.log(`   https://192.168.15.122:${PORT}/batch-system.html`);
        console.log('');
        console.log('⚠️  注意事项:');
        console.log('   - 使用新的数据文件: products-concurrent.json');
        console.log('   - 不影响原有备份版本');
        console.log('   - 支持3人同时安全使用');
        console.log('   - 如遇到SSL证书警告，请选择"继续访问"');
        console.log('');
        console.log('✨ 新增功能:');
        console.log('   - 文件读写锁机制');
        console.log('   - 请求限流保护');
        console.log('   - 原子文件操作');
        console.log('   - 系统状态监控');
        console.log('');
    });
}

// 错误处理
server.on('error', (err) => {
    console.error('服务器启动失败:', err);
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在优雅关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('收到SIGINT信号，正在优雅关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});
