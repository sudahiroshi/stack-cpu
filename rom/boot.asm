; boot.asm — ブートROM（雛形）。番地 $FFFF0000 から始まる。
; docs/spec.md 11章を参照。段階6で実装する。
;
; $FFFF0000  リセット時の入口（全スレッド共通）
;            TID が 0 なら boot、それ以外は idle
; $FFFF0100  例外ベクタ（VBR＋番号×4、番号0〜18）
;            0〜3   スタックのあふれ  → 当面は回復せず、FAULTとして扱う（T-43）
;            4〜7   致命的            → FAULT をカーネルへ送って停止
;            8      SYSCALL           → EXIT / DPUTC / DGETC / MONITOR
;            9      BKPT              → モニタ
;            10〜15 致命的
;            18     未実装命令        → 拡張命令をソフトで実行して RTI
;
; boot:  UARTに起動メッセージ、外部RAMの確認、OSイメージの配置、OSの入口へ
; idle:  スタックを空にし、RECV で START（UP、PC、PKREAD、PKWRITE）を待つ
;        送信元が tid 0 でなければ捨てる。RTI で指定のモード・PCへ

        ORG   $FFFF0000
reset:  HALT              ; TODO（段階6）
