; 08_vram_random.asm — 1秒に1回、テキスト画面のランダムな位置にランダムな色で文字列を出す。30回（30秒）ごとに画面を消す
;
; 動かし方：OSイメージとして、ブートROMから起動する（tid 0、特権モード）。tid 0 で直接実行してもよい。
;   シミュレータでは、速さを「実時間」にして、画面のタブを見る。
;
; 使うもの：
;   タイマ     ユーザーページのカウンタと比較レジスタ（12.6節）。比較値を1秒ずつ足していくので、
;              表示にかかった時間で周期がずれない。待つ間は WAIT（イベント2）で止まる
;   乱数       xorshift32（ソフト）。種はリセットからの時間（マイクロ秒）
;   範囲       乱数 r を 0〜n−1 にするのは、r×n の上位32bit（UM*。除算を使わない）
;   画面       テキストVRAMに直接書く（特権モード）。属性は背景0（黒）、文字色1〜15
; 変数はプログラムの中に置き、PCRELで番地を得る（docs/spec.md 13.2節）。
; 呼び出し規約は13.5節。各関数に ( スタック効果 ) と深さ D+n R+m を書く。

VRAM      EQU $FF010000
UP_CNTLO  EQU $FF0F0000
UP_CNTHI  EQU $FF0F0004
UP_CMPLO  EQU $FF0F0008
UP_CMPHI  EQU $FF0F000C
EV_TIMER  EQU 4                   ; イベントビット2のマスク
PERIOD    EQU 1000000             ; 1秒（マイクロ秒）
CLEAR_N   EQU 30                  ; この回数ごとに画面を消す
COLS      EQU 80
ROWS      EQU 30
MSGLEN    EQU 20                  ; "Example of TEXT VRAM" の文字数
BLANK2    EQU $00200020           ; 空白2文字分（属性0）を32bitで

; ---------------------------------------------------------------- 本体
start:  BSR   cls
        BSR   now                 ; ( lo hi )  いまの時刻を最初の基準にする
        LEA   v_dhi,PC
        ST                        ; ( lo )
        PUSH  T
        LEA   v_dlo,PC
        ST                        ; ( lo )
        PUSHQ #1
        OR                        ; ( seed )   xorshift の種は0以外
        LEA   v_seed,PC
        ST                        ; ( )
loop:   BSR   draw
        BSR   tick                ; 次の1秒まで待つ
        LD    v_count,PC
        ADD   #1
        PUSH  T
        LEA   v_count,PC
        ST                        ; ( n )
        PUSH  #CLEAR_N
        CMPEQ
        BZ    loop
        BSR   cls                 ; 30回出したら画面を消す（cls が回数を0に戻す）
        BRA   loop

; ---------------------------------------------------------------- 表示
; draw ( -- )  D+5 R+3：ランダムな位置・色で文字列を出す
draw:   PUSHQ #15
        BSR   rnd
        ADD   #1                  ; ( fg )     文字色1〜15（0は背景と同じ黒で見えない）
        LEA   v_attr,PC
        ST                        ; ( )
        PUSH  #ROWS
        BSR   rnd                 ; ( row )
        PUSH  #COLS
        MULU
        POP                       ; ( row×80 )
        PUSH  #COLS-MSGLEN+1
        BSR   rnd                 ; ( row×80 col )   文字列が行に収まる桁（0〜60）
        ADD
        PUSHQ #1
        LSL
        PUSH  #VRAM
        ADD                       ; ( vp )
        LEA   s_msg,PC
        EXG                       ; ( s vp )
        BSR   vputs
        RTS

; vputs ( s vp -- )  D+3 R+2：0で終わる文字列を、属性 v_attr で書く
vputs:  PSHR                      ; ( s )      R:( vp )
vp_l:   PUSH  T
        LDB                       ; ( s c )
        PUSH  T
        BZ    vp_e
        PEEKR
        STB                       ; ( s )      文字コード
        LD    v_attr,PC
        PEEKR
        ADD   #1
        STB                       ; ( s )      属性
        PULR
        ADD   #2
        PSHR                      ; ( s )      R:( vp+2 )
        ADD   #1
        BRA   vp_l
vp_e:   POP
        POP
        PULR
        POP
        RTS

; cls ( -- )  D+3 R+2：画面全体を空白にし、表示した回数を0にする
cls:    PUSH  #VRAM
        PUSH  #ROWS*COLS/2        ; ( a n )    32bitで2文字ずつ
cl_l:   PSHR                      ; ( a )      R:( n )
        PUSH  #BLANK2
        PUSH  N
        ST
        ADD   #4
        PULR
        ADD   #-1
        PUSH  T
        BNZ   cl_l
        POP
        POP
        PUSHQ #0
        LEA   v_count,PC
        ST
        RTS

; ---------------------------------------------------------------- 乱数
; rand ( -- x )  D+3 R+1：xorshift32（x ^= x<<13、x ^= x>>17、x ^= x<<5）
rand:   LD    v_seed,PC           ; ( x )
        PUSH  T
        PUSHQ #13
        LSL
        EOR
        PUSH  T
        PUSH  #17
        LSR
        EOR
        PUSH  T
        PUSHQ #5
        LSL
        EOR                       ; ( x' )
        PUSH  T
        LEA   v_seed,PC
        ST                        ; ( x' )
        RTS

; rnd ( n -- r )  D+4 R+2：0〜n−1 の乱数（r＝x×n の上位32bit）
rnd:    BSR   rand                ; ( n x )
        MULU                      ; ( lo hi )
        EXG
        POP                       ; ( r )
        RTS

; ---------------------------------------------------------------- 時間
; now ( -- lo hi )  D+3 R+2：タイマのカウンタ（64bit）。上位→下位→上位と読み、上位が変われば読み直す（12.5節）
now:    LD    UP_CNTHI            ; ( h1 )
        LD    UP_CNTLO            ; ( h1 lo )
        LD    UP_CNTHI            ; ( h1 lo h2 )
        PSHR                      ; ( h1 lo )  R:( h2 )
        EXG                       ; ( lo h1 )
        PEEKR
        CMPEQ                     ; ( lo same )
        BZ    now_r
        PULR                      ; ( lo hi )
        RTS
now_r:  POP
        PULR
        POP
        BRA   now

; tick ( -- )  D+4 R+1：基準の時刻を1秒進め、その時刻まで待つ（過ぎていればすぐ戻る）
tick:   LD    v_dlo,PC
        PUSH  #PERIOD
        ADD                       ; ( lo' )
        PUSH  T
        PUSH  #PERIOD
        CMPLO                     ; ( lo' c )  桁上がりなら −1
        LD    v_dhi,PC
        EXG
        SUB                       ; ( lo' hi' )  hi −（−1）＝ hi＋1
        PUSH  T
        LEA   v_dhi,PC
        ST                        ; ( lo' hi' )
        ST    UP_CMPHI            ; ( lo' )    CMP_HI を書くと比較が止まる
        PUSH  T
        LEA   v_dlo,PC
        ST
        ST    UP_CMPLO            ; ( )        CMP_LO を書くと比較を始める
        PUSHQ #EV_TIMER
        WAIT
        POP
        RTS

; ---------------------------------------------------------------- 変数と文字列
v_seed:  DC.L 1                   ; 乱数の状態
v_dlo:   DC.L 0                   ; 次に表示する時刻（下位）
v_dhi:   DC.L 0                   ; 同（上位）
v_count: DC.L 0                   ; 消してから表示した回数
v_attr:  DC.L 0                   ; 文字列の属性
s_msg:   DC.B "Example of TEXT VRAM",0
