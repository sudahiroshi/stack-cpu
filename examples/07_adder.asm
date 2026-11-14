; 07_adder.asm — UARTから1桁の数字を次々に受け取り、合計をUARTとテキスト画面の両方に出す
;
; 動かし方：OSイメージとして、ブートROMから起動する（tid 0、特権モード）。tid 0 で直接実行してもよい。
;   シミュレータでは、UARTのタブの端末をクリックして、数字のキーを打つ。
;   表示の例：
;     Adder: type digits 0-9
;     +3 = 3
;     +4 = 7
;     +5 = 12
; 数字（0〜9）以外のキーは無視する。
; 1文字ごとに約10文字を表示するので、文字列をまとめて貼り付けると、表示が受信に追いつかず
; UARTの受信FIFO（16バイト）があふれて取りこぼす（キーを打つ速さなら問題ない）。
;
; 使うもの：
;   UART       ブートROMのSYSCALL（2＝DGETC：1文字受け取る、1＝DPUTC：1文字送る）
;   画面       テキストVRAMに直接書く（特権モード）。30行を超えたら SCROLL で画面を送る（VRAMを30行の輪として使う）
;   10進の表示 U/MOD（除算器のない構成では、ブートROMがソフトで代わりに実行する）
; 変数はプログラムの中に置き、PCRELで番地を得る（docs/spec.md 13.2節）。
; 呼び出し規約は13.5節。各関数に ( スタック効果 ) と深さ D+n R+m を書く。

VRAM      EQU $FF010000
CURSOR    EQU $FF003010
CURSORCTL EQU $FF003014
SCROLL    EQU $FF003018
ATTR      EQU $0F                 ; 背景0（黒）、文字色15（白）
BLANK2    EQU $0F200F20           ; 空白2文字分（属性つき）を32bitで
COLS      EQU 80
ROWS      EQU 30

; ---------------------------------------------------------------- 本体
start:  BSR   cls
        PUSH  #$FE03              ; カーソル：表示・点滅、14〜15ライン
        ST    CURSORCTL
        LEA   s_title,PC
        BSR   cputs
loop:   PUSHQ #2                  ; DGETC ( -- c )
        TRAP                      ; ( c )
        PUSH  T
        PUSH  #$30
        CMPLO                     ; ( c c<'0' )
        BNZ   skip
        PUSH  T
        PUSH  #$3A
        CMPLO                     ; ( c c<='9' )
        BZ    skip
        PUSH  #$2B                ; '+'
        BSR   cputc
        PUSH  T
        BSR   cputc               ; 数字をそのまま表示（エコー）
        PUSH  #$30
        SUB                       ; ( d )
        LD    v_total,PC
        ADD                       ; ( total' )
        PUSH  T
        LEA   v_total,PC
        ST                        ; ( total' )
        LEA   s_eq,PC
        BSR   cputs
        BSR   pdec                ; ( )
        BSR   crlf
        BRA   loop
skip:   POP
        BRA   loop

; ---------------------------------------------------------------- 10進の表示
; pdec ( u -- )  D+4 R+5：符号なし10進で表示する（バッファの後ろから1桁ずつ埋める）
pdec:   LEA   dbuf_end,PC         ; ( u p )   p＝終端の0の位置
pd_l:   ADD   #-1                 ; ( u p' )
        EXG                       ; ( p u )
        PUSH  #10
        DIVU                      ; ( p r q )
        PSHR                      ; ( p r ) R:( q )
        PUSH  #$30
        ADD                       ; ( p c )
        PUSH  N
        STB                       ; ( p )     [p] ← c
        PULR                      ; ( p q )
        PUSH  T
        BZ    pd_out
        EXG                       ; ( q p )
        BRA   pd_l
pd_out: POP                       ; ( p )
        BSR   cputs
        RTS

; ---------------------------------------------------------------- 文字の出力（UARTと画面）
; cputs ( addr -- )  D+5 R+4：0で終わる文字列
cputs:  PUSH  T
        LDB
        PUSH  T
        BZ    cs_e
        BSR   cputc
        ADD   #1
        BRA   cputs
cs_e:   POP
        POP
        RTS

; crlf ( -- )  D+4 R+4
crlf:   PUSHQ #13
        BSR   cputc
        PUSHQ #10
        BSR   cputc
        RTS

; cputc ( c -- )  D+4 R+3：1文字をUARTと画面に出す。CRで行の先頭へ、LFで次の行へ
cputc:  PUSH  T
        PUSHQ #1                  ; DPUTC ( c -- )
        TRAP                      ; ( c )
        PUSH  T
        PUSHQ #13
        CMPEQ
        BZ    cc_lf
        POP                       ; CR：行の先頭へ
        PUSHQ #0
        LEA   v_col,PC
        ST
        BRA   cursor
cc_lf:  PUSH  T
        PUSHQ #10
        CMPEQ
        BZ    cc_ch
        POP                       ; LF：次の行へ
        BSR   newline
        BRA   cursor
cc_ch:  BSR   celladdr            ; ( c a )
        PUSH  T
        PSHR                      ; R:( a )
        STB                       ; 文字コード
        PUSH  #ATTR
        PULR
        ADD   #1
        STB                       ; 属性
        LD    v_col,PC            ; 桁を進める。80桁を超えたら次の行の先頭へ
        ADD   #1
        PUSH  T
        LEA   v_col,PC
        ST                        ; ( col' )
        PUSH  #COLS
        CMPEQ
        BZ    cursor
        PUSHQ #0
        LEA   v_col,PC
        ST
        BSR   newline
; cursor ( -- )  D+3 R+1：カーソルの位置を画面の制御レジスタに書く
cursor: LD    v_row,PC
        PUSHQ #8
        LSL
        LD    v_col,PC
        OR
        ST    CURSOR
        RTS

; celladdr ( -- a )  D+3 R+1：いまの桁・行の文字のVRAMの番地
celladdr:
        LD    v_row,PC
        PUSH  #COLS
        MULU
        POP                       ; ( row×80 )
        LD    v_col,PC
        ADD
        PUSHQ #1
        LSL
        PUSH  #VRAM
        ADD
        RTS

; newline ( -- )  D+3 R+3：次の行へ（30行の輪）。その行を消し、一度輪を回ったら SCROLL で画面を送る
newline: LD   v_row,PC
        ADD   #1
        PUSH  T
        PUSH  #ROWS
        CMPEQ
        BZ    nl_1
        POP                       ; 最後の行を過ぎたら0行目へ。以後は画面を送る
        PUSHQ #0
        PUSHQ #-1
        LEA   v_full,PC
        ST
nl_1:   PUSH  T
        LEA   v_row,PC
        ST                        ; ( row )
        BSR   clrow
        LD    v_full,PC
        BZ    nl_e
        LD    v_row,PC            ; SCROLL＝(row＋1) mod 30：いまの行が画面の最下行になる
        ADD   #1
        PUSH  T
        PUSH  #ROWS
        CMPEQ
        BZ    nl_2
        POP
        PUSHQ #0
nl_2:   ST    SCROLL
nl_e:   RTS

; clrow ( row -- )  D+3 R+2：1行（80文字）を空白にする
clrow:  PUSH  #COLS*2
        MULU
        POP
        PUSH  #VRAM
        ADD                       ; ( a )
        PUSH  #COLS/2             ; 32bitで2文字ずつ、40回
cr_l:   PSHR                      ; ( a ) R:( n )
        PUSH  #BLANK2
        PUSH  N
        ST
        ADD   #4
        PULR
        ADD   #-1
        PUSH  T
        BNZ   cr_l
        POP
        POP
        RTS

; cls ( -- )  D+3 R+3：画面全体を空白にし、桁・行・SCROLLを0にする
cls:    PUSH  #ROWS
cl_l:   ADD   #-1
        PUSH  T
        BSR   clrow
        PUSH  T
        BNZ   cl_l
        POP
        PUSHQ #0
        ST    SCROLL
        PUSHQ #0
        LEA   v_col,PC
        ST
        PUSHQ #0
        LEA   v_row,PC
        ST
        PUSHQ #0
        LEA   v_full,PC
        ST
        BSR   cursor
        RTS

; ---------------------------------------------------------------- 変数と文字列
v_total: DC.L 0                   ; 合計
v_col:   DC.L 0                   ; 桁（0〜79）
v_row:   DC.L 0                   ; 行（0〜29、VRAM上の行）
v_full:  DC.L 0                   ; 一度30行を回ったら −1（以後は SCROLL で画面を送る）
s_title: DC.B "Adder: type digits 0-9",13,10,0
s_eq:    DC.B " = ",0
dbuf:    DC.B "0000000000"        ; 10進の表示用（10桁）
dbuf_end: DC.B 0
