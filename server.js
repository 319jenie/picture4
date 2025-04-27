const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

// 创建Express应用
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 添加根路由，确保在Vercel上正确处理
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 限制文件大小为10MB
});

// 创建模型和输出目录
const modelsDir = path.join(__dirname, 'models');
const outputDir = path.join(__dirname, 'public', 'outputs');
if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 存储模板数据 (代替数据库)
const templates = [];

// 路由：获取所有模板
app.get('/api/templates', (req, res) => {
  res.json(templates);
});

// 路由：创建新模板
app.post('/api/templates', upload.array('images', 10), async (req, res) => {
  try {
    const { name } = req.body;
    const images = req.files;
    
    if (!name || !images || images.length < 5) {
      return res.status(400).json({ error: '需要模板名称和至少5张图片' });
    }
    
    // 为模板创建唯一ID
    const templateId = Date.now().toString();
    
    // 创建模板目录
    const templateDir = path.join(modelsDir, templateId);
    fs.mkdirSync(templateDir, { recursive: true });
    
    // 保存模板信息
    const imageUrls = [];
    for (const image of images) {
      imageUrls.push(`/uploads/${image.filename}`);
    }
    
    // 创建缩略图
    const thumbnailPath = await createThumbnail(images[0].path, templateId);
    
    // 处理模板样式
    const avgColors = await analyzeTemplateColors(images);
    fs.writeFileSync(
      path.join(templateDir, 'style-data.json'), 
      JSON.stringify(avgColors)
    );
    
    // 保存模板信息
    const template = {
      _id: templateId,
      name,
      imageCount: images.length,
      thumbnailUrl: `/outputs/thumbnail-${templateId}.jpg`,
      styleData: avgColors,
      createdAt: new Date()
    };
    
    templates.push(template);
    res.status(201).json(template);
  } catch (error) {
    console.error('创建模板错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 路由：删除模板
app.delete('/api/templates/:id', (req, res) => {
  try {
    const templateId = req.params.id;
    const templateIndex = templates.findIndex(t => t._id === templateId);
    
    if (templateIndex === -1) {
      return res.status(404).json({ error: '模板不存在' });
    }
    
    // 删除模板文件夹
    const templateDir = path.join(modelsDir, templateId);
    if (fs.existsSync(templateDir)) {
      fs.rmdirSync(templateDir, { recursive: true });
    }
    
    // 从数组中删除
    templates.splice(templateIndex, 1);
    
    res.json({ success: true });
  } catch (error) {
    console.error('删除模板错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 路由：转换图片
app.post('/api/convert', upload.single('photo'), async (req, res) => {
  try {
    const { templateId, generateOutline, generateColored } = req.body;
    const photo = req.file;
    
    if (!templateId || !photo) {
      return res.status(400).json({ error: '需要模板ID和照片' });
    }
    
    // 查找模板
    const template = templates.find(t => t._id === templateId);
    if (!template) {
      return res.status(404).json({ error: '模板不存在' });
    }
    
    const results = {};
    const timestamp = Date.now();
    
    // 生成线稿
    if (generateOutline === 'true') {
      const outlinePath = `outline-${timestamp}.jpg`;
      await generateOutlineDrawing(photo.path, path.join(outputDir, outlinePath));
      results.outline = `/outputs/${outlinePath}`;
    }
    
    // 生成彩色插画
    if (generateColored === 'true') {
      const coloredPath = `colored-${timestamp}.jpg`;
      await generateColoredIllustration(photo.path, path.join(outputDir, coloredPath), template);
      results.colored = `/outputs/${coloredPath}`;
    }
    
    res.json(results);
  } catch (error) {
    console.error('转换图片错误:', error);
    res.status(500).json({ error: '转换失败' });
  }
});

// 分析模板颜色
async function analyzeTemplateColors(images) {
  try {
    let totalR = 0, totalG = 0, totalB = 0;
    let pixelCount = 0;
    
    for (const image of images) {
      const img = await Jimp.read(image.path);
      
      // 采样图像颜色
      img.scan(0, 0, img.bitmap.width, img.bitmap.height, function(x, y, idx) {
        const r = this.bitmap.data[idx + 0];
        const g = this.bitmap.data[idx + 1];
        const b = this.bitmap.data[idx + 2];
        
        totalR += r;
        totalG += g;
        totalB += b;
        pixelCount++;
      });
    }
    
    // 计算平均颜色
    const avgColor = {
      r: Math.round(totalR / pixelCount),
      g: Math.round(totalG / pixelCount),
      b: Math.round(totalB / pixelCount)
    };
    
    return {
      dominantColor: avgColor,
      colorCount: pixelCount
    };
  } catch (error) {
    console.error('分析模板颜色错误:', error);
    throw error;
  }
}

// 创建缩略图
async function createThumbnail(imagePath, templateId) {
  try {
    const outputPath = path.join(outputDir, `thumbnail-${templateId}.jpg`);
    
    const image = await Jimp.read(imagePath);
    
    // 裁剪为正方形并调整大小
    const size = Math.min(image.bitmap.width, image.bitmap.height);
    const x = (image.bitmap.width - size) / 2;
    const y = (image.bitmap.height - size) / 2;
    
    await image
      .crop(x, y, size, size)
      .resize(200, 200)
      .quality(80)
      .writeAsync(outputPath);
    
    return outputPath;
  } catch (error) {
    console.error('创建缩略图错误:', error);
    throw error;
  }
}

// 生成线稿
async function generateOutlineDrawing(inputPath, outputPath) {
  try {
    const image = await Jimp.read(inputPath);
    
    // 创建新的图像作为线稿
    const outline = new Jimp(image.bitmap.width, image.bitmap.height, 0xffffffff);
    
    // 边缘检测 - 简化版
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, idx) {
      // 跳过边缘像素
      if (x === 0 || y === 0 || x === image.bitmap.width - 1 || y === image.bitmap.height - 1) return;
      
      const thisPixel = Jimp.intToRGBA(image.getPixelColor(x, y));
      const leftPixel = Jimp.intToRGBA(image.getPixelColor(x - 1, y));
      const rightPixel = Jimp.intToRGBA(image.getPixelColor(x + 1, y));
      const topPixel = Jimp.intToRGBA(image.getPixelColor(x, y - 1));
      const bottomPixel = Jimp.intToRGBA(image.getPixelColor(x, y + 1));
      
      // 计算相邻像素的差异
      const diffX = Math.abs(leftPixel.r - rightPixel.r) + 
                   Math.abs(leftPixel.g - rightPixel.g) + 
                   Math.abs(leftPixel.b - rightPixel.b);
                   
      const diffY = Math.abs(topPixel.r - bottomPixel.r) + 
                   Math.abs(topPixel.g - bottomPixel.g) + 
                   Math.abs(topPixel.b - bottomPixel.b);
      
      // 如果差异大于阈值，则标记为边缘
      if (diffX > 100 || diffY > 100) {
        outline.setPixelColor(0x000000ff, x, y); // 黑色
      }
    });
    
    // 保存为文件
    await outline.writeAsync(outputPath);
    
    return outputPath;
  } catch (error) {
    console.error('生成线稿错误:', error);
    throw error;
  }
}

// 生成彩色插画
async function generateColoredIllustration(inputPath, outputPath, template) {
  try {
    const image = await Jimp.read(inputPath);
    
    // 风格化处理
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, idx) {
      const r = this.bitmap.data[idx + 0];
      const g = this.bitmap.data[idx + 1];
      const b = this.bitmap.data[idx + 2];
      
      // 计算亮度和饱和度
      const avg = (r + g + b) / 3;
      
      // 增强饱和度
      this.bitmap.data[idx + 0] = Math.min(255, r + (r - avg) * 0.5);
      this.bitmap.data[idx + 1] = Math.min(255, g + (g - avg) * 0.5);
      this.bitmap.data[idx + 2] = Math.min(255, b + (b - avg) * 0.5);
      
      // 量化颜色 (卡通效果)
      this.bitmap.data[idx + 0] = Math.round(this.bitmap.data[idx + 0] / 32) * 32;
      this.bitmap.data[idx + 1] = Math.round(this.bitmap.data[idx + 1] / 32) * 32;
      this.bitmap.data[idx + 2] = Math.round(this.bitmap.data[idx + 2] / 32) * 32;
    });
    
    // 创建线稿
    const outline = new Jimp(image.bitmap.width, image.bitmap.height, 0x00000000); // 透明
    
    // 检测边缘
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, idx) {
      // 跳过边缘像素
      if (x === 0 || y === 0 || x === image.bitmap.width - 1 || y === image.bitmap.height - 1) return;
      
      const thisPixel = Jimp.intToRGBA(image.getPixelColor(x, y));
      const leftPixel = Jimp.intToRGBA(image.getPixelColor(x - 1, y));
      const rightPixel = Jimp.intToRGBA(image.getPixelColor(x + 1, y));
      const topPixel = Jimp.intToRGBA(image.getPixelColor(x, y - 1));
      const bottomPixel = Jimp.intToRGBA(image.getPixelColor(x, y + 1));
      
      // 计算相邻像素的差异
      const diffX = Math.abs(leftPixel.r - rightPixel.r) + 
                   Math.abs(leftPixel.g - rightPixel.g) + 
                   Math.abs(leftPixel.b - rightPixel.b);
                   
      const diffY = Math.abs(topPixel.r - bottomPixel.r) + 
                   Math.abs(topPixel.g - bottomPixel.g) + 
                   Math.abs(topPixel.b - bottomPixel.b);
      
      // 如果差异大于阈值，则标记为边缘
      if (diffX > 100 || diffY > 100) {
        outline.setPixelColor(0x000000ff, x, y); // 黑色
      }
    });
    
    // 合并线稿和彩色图像
    image.composite(outline, 0, 0, {
      mode: Jimp.BLEND_SOURCE_OVER,
      opacitySource: 1,
      opacityDest: 1
    });
    
    // 保存为文件
    await image.writeAsync(outputPath);
    
    return outputPath;
  } catch (error) {
    console.error('生成彩色插画错误:', error);
    throw error;
  }
}

// 启动服务器
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
  });
}

// 对于Vercel和类似平台的部署
module.exports = app; 