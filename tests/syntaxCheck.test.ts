import { checkSyntax } from '../src/services/syntaxCheck';

const REPO_DIR = '/tmp/fake-repo';

describe('checkSyntax()', () => {
  it('rejects files with leftover conflict markers', async () => {
    const content = `const x = 1;\n<<<<<<< HEAD\nconst y = 2;\n=======\nconst z = 3;\n>>>>>>> MERGE_HEAD\n`;
    const result = await checkSyntax('src/test.ts', content, REPO_DIR);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/conflict marker/i);
  });

  it('accepts valid TypeScript', async () => {
    const content = `
const greeting: string = 'hello';
function add(a: number, b: number): number {
  return a + b;
}
export { greeting, add };
    `.trim();
    const result = await checkSyntax('src/utils.ts', content, REPO_DIR);
    expect(result.valid).toBe(true);
  });

  it('rejects TypeScript with syntax errors', async () => {
    const content = `
function broken( {
  return 'unclosed';
}
    `.trim();
    const result = await checkSyntax('src/broken.ts', content, REPO_DIR);
    expect(result.valid).toBe(false);
  });

  it('accepts valid JavaScript', async () => {
    const content = `module.exports = { foo: 'bar' };`;
    const result = await checkSyntax('index.js', content, REPO_DIR);
    expect(result.valid).toBe(true);
  });

  it('accepts unknown file types (no markers present)', async () => {
    const content = `# markdown content\n\nsome text`;
    const result = await checkSyntax('README.md', content, REPO_DIR);
    expect(result.valid).toBe(true);
  });
});
