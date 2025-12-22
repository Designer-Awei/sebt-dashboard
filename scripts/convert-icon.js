/**
 * 将PNG图标转换为多尺寸ICO文件
 * 使用sharp库生成Windows所需的多个尺寸，并使用to-ico生成真正的ICO文件
 */

const sharp = require('sharp');
const toIco = require('to-ico');
const fs = require('fs');
const path = require('path');

const inputPng = path.join(__dirname, '../public/SEBT Assistant.png');
const outputDir = path.join(__dirname, '../build');
const outputIco = path.join(outputDir, 'icon.ico');

// 确保build目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Windows ICO文件需要的尺寸（像素）
const sizes = [16, 32, 48, 64, 128, 256];

async function convertToIco() {
  try {
    console.log('🔄 开始转换PNG图标为ICO格式...');
    console.log(`输入文件: ${inputPng}`);
    console.log(`输出文件: ${outputIco}`);

    // 读取原始PNG
    const image = sharp(inputPng);
    const metadata = await image.metadata();
    console.log(`原始图片尺寸: ${metadata.width}x${metadata.height}`);

    // 生成各个尺寸的PNG并转换为Buffer
    const pngBuffers = [];
    for (const size of sizes) {
      const buffer = await image
        .clone()
        .resize(size, size, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 0 }
        })
        .png()
        .toBuffer();
      pngBuffers.push(buffer);
      console.log(`✓ 生成 ${size}x${size} 尺寸图标`);
    }

    // 使用to-ico将多个PNG Buffer合并为ICO文件
    const icoBuffer = await toIco(pngBuffers);
    fs.writeFileSync(outputIco, icoBuffer);
    console.log(`✓ 生成ICO文件: ${outputIco}`);

    console.log('✅ 图标转换完成！');
    console.log(`ICO文件: ${outputIco}`);

  } catch (error) {
    console.error('❌ 图标转换失败:', error);
    process.exit(1);
  }
}

convertToIco();
