import {Console} from 'node:console';

/** ACP owns stdout exclusively. Dependency diagnostics (including MCP SDK
 * console.debug calls) belong to the untrusted stderr stream drained by the
 * guardian. Direct protocol writes to process.stdout remain untouched. */
globalThis.console=new Console({stdout:process.stderr,stderr:process.stderr});
