// CPUの例外（docs/spec.md 7章）をシミュレータの内部で伝えるための例外クラス。
// メモリや命令の実行で投げ、コア（sim/core.js）が受け取って例外の処理をする。

export class CpuException extends Error {
  /**
   * @param {number} exc 例外番号（sim/isa.js の EXC）
   * @param {number} [addr] 問題になったアドレス（EADDRに入る。アドレスに関係しない例外では0。T-30）
   */
  constructor(exc, addr = 0) {
    super(`例外${exc}（アドレス $${(addr >>> 0).toString(16).toUpperCase()}）`);
    this.name = 'CpuException';
    this.exc = exc;
    this.addr = addr >>> 0;
  }
}
