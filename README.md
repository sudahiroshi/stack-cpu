# stack-cpu-sim

Tang Nano（9K／20K）向けに設計中の32bitスタックマシンCPU（バレル方式）の、命令セットシミュレータとアセンブラ。

- 仕様書：[docs/spec.md](docs/spec.md)
- 決定の記録：[docs/decisions.md](docs/decisions.md)
- 開発の規則（Claude Code向け）：[CLAUDE.md](CLAUDE.md)

## 必要なもの

- Node.js 20以上（テストとツール）
- ブラウザ（UI）

外部パッケージは使っていないので、`npm install` は不要です。

## 使い方

```sh
npm test        # テスト
npm run serve   # http://localhost:8000/ui/ をブラウザで開く
```

## 状況

段階4（例外、スタック深さの判定、保護キー）まで完了。実装は CLAUDE.md の「実装の順番」に沿って進める。

```sh
npm run asm -- examples/01_sum.asm                     # リスティングを表示
npm run asm -- examples/01_sum.asm -o out.bin --hex out.hex   # バイナリと $readmemh 形式
```

オプション：`--list file`（リスティング）、`--origin addr`（ORGがないときの開始番地）、`--forth`（Forth風で逆アセンブル）、`--no-slot6`（slot6にNOP以外を詰めない）。
