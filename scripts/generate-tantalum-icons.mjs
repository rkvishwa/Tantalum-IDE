import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const rootDir = path.resolve(import.meta.dirname, '..');
const logoDir = path.join(rootDir, 'resources/logos');
const iconDir = path.join(rootDir, 'resources/icons');
const rendererAssetsDir = path.join(rootDir, 'renderer-react/src/assets');
const siteLogoDir = path.join(rootDir, 'sites/home/public/logos');

const variants = [
  {
    logoName: 'tantalum-logo-light',
    iconName: 'tantalum-icon',
    svgPath: path.join(logoDir, 'tantalum-logo-light.svg'),
  },
  {
    logoName: 'tantalum-logo-dark',
    iconName: 'tantalum-icon-dark',
    svgPath: path.join(logoDir, 'tantalum-logo-dark.svg'),
  },
];

for (const dir of [logoDir, iconDir, rendererAssetsDir, siteLogoDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
  });
  return resvg.render().asPng();
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

function icns(images) {
  const typeBySize = new Map([
    [16, 'icp4'],
    [32, 'icp5'],
    [64, 'icp6'],
    [128, 'ic07'],
    [256, 'ic08'],
    [512, 'ic09'],
    [1024, 'ic10'],
  ]);
  const chunks = images.map(({ size, data }) => {
    const header = Buffer.alloc(8);
    header.write(typeBySize.get(size), 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(8 + chunks.reduce((total, item) => total + item.length, 0), 4);
  return Buffer.concat([fileHeader, ...chunks]);
}

const sizes = [16, 32, 48, 64, 128, 192, 256, 512, 1024];

for (const variant of variants) {
  const svg = fs.readFileSync(variant.svgPath, 'utf8');
  const images = sizes.map((size) => ({ size, data: renderPng(svg, size) }));

  fs.writeFileSync(path.join(iconDir, `${variant.iconName}.svg`), svg);
  fs.writeFileSync(path.join(rendererAssetsDir, `${variant.iconName}.svg`), svg);
  fs.writeFileSync(path.join(siteLogoDir, `${variant.logoName}.svg`), svg);

  for (const image of images) {
    fs.writeFileSync(path.join(iconDir, `${variant.iconName}-${image.size}.png`), image.data);
    fs.writeFileSync(path.join(logoDir, `${variant.logoName}-${image.size}.png`), image.data);
  }

  fs.writeFileSync(path.join(iconDir, `${variant.iconName}.png`), images.find((image) => image.size === 512).data);
  fs.writeFileSync(path.join(logoDir, `${variant.logoName}.png`), images.find((image) => image.size === 512).data);
  fs.writeFileSync(path.join(iconDir, `${variant.iconName}.ico`), ico(images.filter((image) => image.size <= 256)));
  fs.writeFileSync(
    path.join(iconDir, `${variant.iconName}.icns`),
    icns(images.filter((image) => [16, 32, 64, 128, 256, 512, 1024].includes(image.size))),
  );

  fs.writeFileSync(
    path.join(siteLogoDir, `${variant.logoName}-192.png`),
    images.find((image) => image.size === 192).data,
  );
  fs.writeFileSync(
    path.join(siteLogoDir, `${variant.logoName}-512.png`),
    images.find((image) => image.size === 512).data,
  );

  console.log(`Generated assets for ${variant.logoName} from ${variant.svgPath}`);
}
