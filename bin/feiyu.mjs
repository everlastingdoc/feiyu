#!/usr/bin/env node
try {
  const { main } = await import('../dist/src/cli.js');
  await main(process.argv.slice(2));
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && !error?.message?.includes('node_modules')) {
    console.error('请先执行 npm ci --ignore-scripts 和 npm run build。');
  } else {
    // Never dump an upstream stack/body or environment on the public CLI.
    const { safeError } = await import('../dist/src/util.js').catch(() => ({ safeError: () => '启动失败，请检查依赖和构建。' }));
    const secrets = Object.entries(process.env).filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD/.test(k)).map(([,v]) => v).filter(Boolean);
    console.error(safeError(error, secrets));
  }
  process.exitCode = 1;
}
