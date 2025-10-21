// patch.js - Fixes cosmjs directory import issue
const fs = require('fs');
const path = require('path');

const filePath = path.join(
  __dirname,
  'node_modules/@cosmjs/tendermint-rpc/build/tendermint34/adaptor/index.js'
);

const dir = path.dirname(filePath);

// Check if the adaptor directory exists
if (fs.existsSync(dir) && !fs.existsSync(filePath)) {
  // Find the actual file in the directory
  const files = fs.readdirSync(dir);
  console.log('📦 Patching cosmjs import issue...');
  console.log('Files in adaptor directory:', files);
  
  // Create an index.js if it doesn't exist
  if (files.length > 0 && files.some(f => f.endsWith('.js'))) {
    const mainFile = files.find(f => f.endsWith('.js'));
    const exportContent = `export * from './${mainFile}';\n`;
    fs.writeFileSync(filePath, exportContent);
    console.log('✅ Created index.js export file');
  }
} else {
  console.log('✅ No patching needed');
}