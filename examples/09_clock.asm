; 09_clock.asm — テキスト画面のアナログ時計。UARTから4桁（HHMM）を打つと時刻を合わせる
;
; 動かし方：OSイメージとして、ブートROMから起動する（tid 0、特権モード）。tid 0 で直接実行してもよい。
;   シミュレータでは、速さを「実時間」にして画面のタブを見る。時刻を合わせるときは、UARTのタブの端末をクリックして
;   4桁の数字を打つ（1時1分なら 0101、23時59分なら 2359）。
;
; 時刻：起動した瞬間を 00:00:00 とする。4桁を打ち終えると、その時刻の0秒から数え直す。
;   ありえない時刻（時が24以上、分が60以上）は無視する（UARTに " ?" を返す）。
;   数字以外のキー（Enterなど）を打つと、打ちかけの数字を捨てる。
;
; 画面：80桁×30行の文字で、ほぼ画面いっぱいに文字盤を描く。文字の大きさが横8×縦16ドットなので、
;   横の半径を縦の半径（行）の2倍の桁にすると円になる（横28桁、縦14行）。
;     文字盤   外周に分の目盛り（.）と時の目盛り（o）、内側に1〜12の数字
;     短針 #（黄）  長針 *（明るい水色）  秒針 .（明るい赤）  最下行に HH:MM:SS（24時間制）
;   毎秒、前の針を空白で消してから、新しい位置に描き直す。
;
; 使うもの：
;   タイマ     ユーザーページのカウンタと比較レジスタ（12.6節）。比較値を1秒ずつ足すので、周期がずれない
;   WAIT       タイマ（イベント2）とUARTの受信（イベント4）を同時に待つ
;   三角関数   sin を256倍した60通りの表（6度ごと）。cos(p) ＝ sin(p＋15)
;   針の点     中心から半径の i/32 の点：桁＝CX＋sin×i×RX/8192、行＝CY−cos×i×RY/8192（四捨五入）
;   UART       受信は DATA レジスタを直接読む（特権モード）。送信はブートROMのSYSCALL 1（DPUTC）
;   除算       U/MOD（時刻の入力と表示だけ。除算器のない構成では、ブートROMがソフトで代わりに実行する）
; 変数はプログラムの中に置き、PCRELで番地を得る（docs/spec.md 13.2節）。
; 呼び出し規約は13.5節。各関数に ( スタック効果 ) と深さ D+n R+m を書く。

VRAM      EQU $FF010000
UART_DATA EQU $FF000000
UP_CNTLO  EQU $FF0F0000
UP_CNTHI  EQU $FF0F0004
UP_CMPLO  EQU $FF0F0008
UP_CMPHI  EQU $FF0F000C
EV_TIMER  EQU 4                   ; イベントビット2（タイマ）のマスク
EV_RX     EQU 16                  ; イベントビット4（UARTの受信データあり）のマスク
PERIOD    EQU 1000000             ; 1秒（マイクロ秒）
COLS      EQU 80
ROWS      EQU 30
BLANK2    EQU $0F200F20           ; 空白2文字分（属性：黒地に白）を32bitで
CX        EQU 40                  ; 文字盤の中心（桁）
CY        EQU 14                  ; 同（行）。外周は0〜28行、最下行（29行）は時刻の表示
RX        EQU 28                  ; 横の半径（桁）
RY        EQU 14                  ; 縦の半径（行）
L_RING    EQU 32                  ; 目盛りの位置（半径の32/32）
L_NUM     EQU 27                  ; 数字の位置
L_SEC     EQU 24                  ; 秒針の長さ（半径の24/32）
L_MIN     EQU 22                  ; 長針の長さ
L_HOUR    EQU 14                  ; 短針の長さ
A_BG      EQU $0F                 ; 消すときの属性（黒地に白）
A_TICK    EQU $08                 ; 分の目盛り（暗い灰色）
A_HTICK   EQU $0A                 ; 時の目盛り（明るい緑）
A_HOUR    EQU $0E                 ; 短針（黄）
A_MIN     EQU $0B                 ; 長針（明るい水色）
A_SEC     EQU $0C                 ; 秒針（明るい赤）
TIME_POS  EQU VRAM+(29*COLS+1)*2  ; 時刻の表示の位置（29行・1桁）
HELP_POS  EQU VRAM+(29*COLS+12)*2 ; 説明の位置（29行・12桁）

; ---------------------------------------------------------------- 本体
start:  BSR   cls
        BSR   dial
        LEA   s_help,PC
        PUSH  #HELP_POS
        BSR   vputs
        LEA   s_title,PC
        BSR   tputs
        BSR   restart             ; いまを基準に、1秒後のタイマをかける
        BSR   update              ; 00:00:00 を描く
main:   PUSH  #EV_TIMER+EV_RX
        WAIT                      ; ( bits )
        PUSH  T
        PUSH  #EV_RX
        AND
        BZ    m_tm
        BSR   uart_in             ; 届いた文字をすべて処理する
m_tm:   PUSHQ #EV_TIMER
        AND
        BZ    main
        BSR   schedule            ; 次の1秒のタイマをかけ直す
        BSR   advance             ; 1秒進める
        BSR   update
        BRA   main

; ---------------------------------------------------------------- 時刻
; advance ( -- )  D+5 R+2：1秒進める（秒→分→時の桁上がり）
advance: LEA  v_s,PC
        PUSH  #60
        BSR   inc
        BZ    adv_e
        LEA   v_m,PC
        PUSH  #60
        BSR   inc
        BZ    adv_e
        LEA   v_h,PC
        PUSH  #24
        BSR   inc
        POP
adv_e:  RTS

; inc ( a lim -- carry )  D+4 R+2：[a]に1を足す。limになったら0に戻して carry＝−1、それ以外は0
inc:    PSHR                      ; ( a )      R:( lim )
        PUSH  T
        LD
        ADD   #1                  ; ( a v )
        PUSH  T
        PULR
        CMPEQ                     ; ( a v eq )
        PUSH  T
        PSHR                      ; ( a v eq ) R:( eq )
        BZ    inc_1
        POP
        PUSHQ #0                  ; ( a 0 )
inc_1:  EXG
        ST                        ; ( )        [a] ← v
        PULR                      ; ( carry )
        RTS

; ---------------------------------------------------------------- UARTの入力
; uart_in ( -- )  D+6 R+4：受信FIFOの文字をすべて読んで key に渡す
uart_in: LD   UART_DATA           ; ( d )      bit31＝1なら受信データなし
        PUSH  T
        PUSHQ #0
        CMPLT
        BNZ   ui_e
        BSR   key
        BRA   uart_in
ui_e:   POP
        RTS

; key ( c -- )  D+5 R+3：数字なら貯め、4桁そろったら時刻にする。数字以外なら貯めた数字を捨てる
key:    PUSH  T
        PUSH  #$30
        CMPLO
        BNZ   k_other
        PUSH  T
        PUSH  #$3A
        CMPLO
        BZ    k_other
        PUSH  T
        PUSHQ #1
        TRAP                      ; ( c )      エコー（DPUTC）
        PUSH  #$30
        SUB                       ; ( d )
        LD    v_val,PC
        PUSH  #10
        MULU
        POP
        ADD                       ; ( val×10＋d )
        LEA   v_val,PC
        ST                        ; ( )
        LD    v_cnt,PC
        ADD   #1
        PUSH  T
        LEA   v_cnt,PC
        ST                        ; ( cnt )
        PUSHQ #4
        CMPEQ
        BZ    k_e
        BSR   setval
        BRA   k_clr
k_other: POP
k_clr:  PUSHQ #0
        LEA   v_val,PC
        ST
        PUSHQ #0
        LEA   v_cnt,PC
        ST
k_e:    RTS

; setval ( -- )  D+5 R+3：貯めた4桁（HHMM）を時刻にする。ありえない時刻なら無視する
setval: LD    v_val,PC
        PUSH  #100
        DIVU                      ; ( mm hh )
        PUSH  T
        PUSH  #24
        CMPLO
        BZ    sv_ng
        PUSH  N
        PUSH  #60
        CMPLO
        BZ    sv_ng
        LEA   v_h,PC
        ST                        ; ( mm )
        LEA   v_m,PC
        ST                        ; ( )
        PUSHQ #0
        LEA   v_s,PC
        ST
        LEA   s_ok,PC
        BSR   tputs
        BSR   restart             ; 合わせた瞬間を0秒として数え直す
        BSR   update
        RTS
sv_ng:  POP
        POP
        LEA   s_ng,PC
        BSR   tputs
        RTS

; tputs ( s -- )  D+4 R+2：0で終わる文字列をUARTに送る（DPUTC）
tputs:  PUSH  T
        LDB
        PUSH  T
        BZ    tp_e
        PUSHQ #1
        TRAP
        ADD   #1
        BRA   tputs
tp_e:   POP
        POP
        RTS

; ---------------------------------------------------------------- 描画
; update ( -- )  D+7 R+5：前の針を消し、いまの時刻の針と時刻の表示を描く
update: PUSH  #$20                ; 前の針を空白で消す
        PUSHQ #A_BG
        BSR   setch
        LD    v_ps,PC
        PUSH  #L_SEC
        BSR   hand
        LD    v_pm,PC
        PUSH  #L_MIN
        BSR   hand
        LD    v_ph,PC
        PUSH  #L_HOUR
        BSR   hand
        LD    v_s,PC              ; 新しい位置（0〜59）
        LEA   v_ps,PC
        ST
        LD    v_m,PC
        LEA   v_pm,PC
        ST
        LD    v_h,PC              ; 短針：(時 mod 12)×5＋分÷12
        PUSH  T
        PUSH  #12
        CMPLO
        BNZ   up_1
        ADD   #-12
up_1:   PUSHQ #5
        MULU
        POP
        LD    v_m,PC
        PUSH  #12
        DIVU
        EXG
        POP
        ADD
        LEA   v_ph,PC
        ST
        PUSH  #$23                ; 短針 #
        PUSHQ #A_HOUR
        BSR   setch
        LD    v_ph,PC
        PUSH  #L_HOUR
        BSR   hand
        PUSH  #$2A                ; 長針 *
        PUSHQ #A_MIN
        BSR   setch
        LD    v_pm,PC
        PUSH  #L_MIN
        BSR   hand
        PUSH  #$2E                ; 秒針 .（一番上に描く）
        PUSHQ #A_SEC
        BSR   setch
        LD    v_ps,PC
        PUSH  #L_SEC
        BSR   hand
        PUSH  #$4F                ; 中心 O
        PUSHQ #A_BG
        BSR   setch
        PUSHQ #0
        PUSHQ #0
        BSR   cell
        BSR   putv
        BSR   digital
        RTS

; digital ( -- )  D+6 R+4：最下行に HH:MM:SS を書く
digital: LD   v_h,PC
        PUSH  #TIME_POS
        BSR   put2                ; ( a )
        PUSH  #$3A
        EXG
        BSR   putc
        LD    v_m,PC
        EXG
        BSR   put2
        PUSH  #$3A
        EXG
        BSR   putc
        LD    v_s,PC
        EXG
        BSR   put2
        POP
        RTS

; put2 ( n a -- a' )  D+4 R+3：0〜99を2桁で書き、次の文字の番地を返す（属性はそのまま）
put2:   PSHR                      ; ( n )      R:( a )
        PUSH  #10
        DIVU                      ; ( 一の位 十の位 )
        PUSH  #$30
        ADD
        PULR
        BSR   putc                ; ( r a' )
        PSHR
        PUSH  #$30
        ADD
        PULR
        BSR   putc                ; ( a'' )
        RTS

; putc ( c a -- a+2 )  D+3 R+2：文字コードだけを書く（属性はそのまま）
putc:   PUSH  T
        PSHR
        STB
        PULR
        ADD   #2
        RTS

; dial ( -- )  D+8 R+5：文字盤（外周の目盛りと1〜12の数字）を描く
dial:   PUSH  #$2E                ; 分の目盛り .
        PUSHQ #A_TICK
        BSR   setch
        PUSH  #59
dl_l:   PUSH  T
        PUSH  #L_RING
        BSR   cell
        BSR   putv
        ADD   #-1
        PUSH  T
        PUSHQ #0
        CMPLT
        BZ    dl_l
        POP
        PUSH  #$6F                ; 時の目盛り o
        PUSHQ #A_HTICK
        BSR   setch
        PUSH  #12
dn_l:   PUSH  T
        PUSHQ #5
        MULU
        POP                       ; ( n p )    p＝n×5（12時は60＝0の位置）
        PUSH  T
        PUSH  #L_RING
        BSR   cell
        BSR   putv
        PUSH  #L_NUM
        BSR   cell                ; ( n a )
        PUSH  N
        EXG
        BSR   num                 ; ( n )
        ADD   #-1
        PUSH  T
        BNZ   dn_l
        POP
        RTS

; num ( n a -- )  D+4 R+1：1〜12を書く。2桁なら十の位を1つ左に置く（属性はそのまま）
num:    PUSH  N
        PUSH  #10
        CMPLO
        BNZ   nm_1
        PUSH  #$31                ; 十の位の 1
        PUSH  N
        ADD   #-2
        STB
        EXG
        ADD   #-10
        EXG
nm_1:   EXG
        PUSH  #$30
        ADD
        EXG
        STB
        RTS

; hand ( p len -- )  D+7 R+5：位置p（0〜59）の向きに、中心から長さlenまでの点を v_ch・v_at で描く
hand:   PSHR                      ; ( p )      R:( i )
hd_l:   PUSH  T
        PEEKR
        BSR   cell                ; ( p a )
        BSR   putv                ; ( p )
        PULR
        ADD   #-1
        PUSH  T
        PSHR                      ; ( p i' )   R:( i' )
        BNZ   hd_l
        PULR
        POP
        POP
        RTS

; setch ( c attr -- )  D+2 R+1：putv で書く文字と属性を決める
setch:  LEA   v_at,PC
        ST
        LEA   v_ch,PC
        ST
        RTS

; putv ( a -- )  D+3 R+1：番地aの文字に v_ch・v_at を書く
putv:   LD    v_ch,PC
        PUSH  N
        STB                       ; ( a )
        LD    v_at,PC
        EXG
        ADD   #1
        STB                       ; ( )
        RTS

; cell ( p i -- a )  D+6 R+4：位置p（0〜59）の向きで、中心から半径の i/32 の点の、VRAMの番地
cell:   PSHR                      ; ( p )      R:( i )
        PUSH  T
        BSR   sinp                ; ( p s )
        PEEKR
        PUSH  #RX
        BSR   scale               ; ( p dx )
        PUSH  #CX
        ADD                       ; ( p col )
        EXG
        ADD   #15
        BSR   sinp                ; ( col c )  cos(p)＝sin(p＋15)
        PULR
        PUSH  #RY
        BSR   scale               ; ( col dy )
        PUSH  #CY
        EXG
        SUB                       ; ( col row )  行は下向きが正なので引く
        PUSH  #COLS
        MULU
        POP
        ADD
        PUSHQ #1
        LSL
        PUSH  #VRAM
        ADD                       ; ( a )
        RTS

; sinp ( p -- s )  D+2 R+1：sin(p×6度)×256（pは0〜74。60以上は60を引く）
sinp:   PUSH  T
        PUSH  #60
        CMPLO
        BNZ   sp_1
        ADD   #-60
sp_1:   PUSHQ #2
        LSL
        LEA   t_sin,PC
        ADD
        LD
        RTS

; scale ( s i k -- d )  D+3 R+1：s×i×k÷8192 を四捨五入（sは符号付き。下位32bitの積は符号付きでも正しい）
;   論理右シフトしかないので、2^20 を足して正にしてからずらし、128（＝2^20÷8192）を引く
scale:  MULU
        POP                       ; ( s i×k )
        MULU
        POP                       ; ( v )
        PUSH  #$100000+4096
        ADD
        PUSHQ #13
        LSR
        PUSH  #128
        SUB
        RTS

; vputs ( s a -- )  D+4 R+2：0で終わる文字列を書く（属性はそのまま）
vputs:  PSHR                      ; ( s )      R:( a )
vs_l:   PUSH  T
        LDB
        PUSH  T
        BZ    vs_e
        PULR
        BSR   putc
        PSHR
        ADD   #1
        BRA   vs_l
vs_e:   POP
        POP
        PULR
        POP
        RTS

; cls ( -- )  D+3 R+2：画面全体を空白（黒地に白）にする
cls:    PUSH  #VRAM
        PUSH  #ROWS*COLS/2        ; ( a n )    32bitで2文字ずつ
cl_l:   PSHR
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
        RTS

; ---------------------------------------------------------------- タイマ
; restart ( -- )  D+5 R+3：いまの時刻を基準にして、1秒後のタイマをかける
restart: BSR  now                 ; ( lo hi )
        LEA   v_dhi,PC
        ST
        LEA   v_dlo,PC
        ST
        BSR   schedule
        RTS

; now ( -- lo hi )  D+3 R+2：タイマのカウンタ（64bit）。上位→下位→上位と読み、上位が変われば読み直す（12.5節）
now:    LD    UP_CNTHI            ; ( h1 )
        LD    UP_CNTLO            ; ( h1 lo )
        LD    UP_CNTHI            ; ( h1 lo h2 )
        PSHR                      ; ( h1 lo )  R:( h2 )
        EXG
        PEEKR
        CMPEQ                     ; ( lo same )
        BZ    now_r
        PULR                      ; ( lo hi )
        RTS
now_r:  POP
        PULR
        POP
        BRA   now

; schedule ( -- )  D+4 R+1：基準の時刻を1秒進め、その時刻にタイマのイベントが立つようにする
schedule: LD  v_dlo,PC
        PUSH  #PERIOD
        ADD                       ; ( lo' )
        PUSH  T
        PUSH  #PERIOD
        CMPLO                     ; ( lo' c )  桁上がりなら −1
        LD    v_dhi,PC
        EXG
        SUB                       ; ( lo' hi' )
        PUSH  T
        LEA   v_dhi,PC
        ST
        ST    UP_CMPHI            ; ( lo' )    CMP_HI を書くと比較が止まる
        PUSH  T
        LEA   v_dlo,PC
        ST
        ST    UP_CMPLO            ; ( )        CMP_LO を書くと比較を始める
        RTS

; ---------------------------------------------------------------- 変数・表・文字列
v_h:     DC.L 0                   ; 時（0〜23）
v_m:     DC.L 0                   ; 分（0〜59）
v_s:     DC.L 0                   ; 秒（0〜59）
v_ph:    DC.L 0                   ; いま描いている短針の位置（0〜59）
v_pm:    DC.L 0                   ; 長針の位置
v_ps:    DC.L 0                   ; 秒針の位置
v_dlo:   DC.L 0                   ; 次に1秒進める時刻（下位）
v_dhi:   DC.L 0                   ; 同（上位）
v_val:   DC.L 0                   ; 入力中の数字
v_cnt:   DC.L 0                   ; 入力した桁数
v_ch:    DC.L 0                   ; putv で書く文字
v_at:    DC.L 0                   ; putv で書く属性
; sin(p×6度)×256（p＝0〜59）
t_sin:   DC.L 0,27,53,79,104,128,150,171,190,207
         DC.L 222,234,243,250,255,256,255,250,243,234
         DC.L 222,207,190,171,150,128,104,79,53,27
         DC.L 0,-27,-53,-79,-104,-128,-150,-171,-190,-207
         DC.L -222,-234,-243,-250,-255,-256,-255,-250,-243,-234
         DC.L -222,-207,-190,-171,-150,-128,-104,-79,-53,-27
s_title: DC.B "Analog clock: type HHMM to set the time (e.g. 0101 = 1:01)",13,10,0
s_help:  DC.B "Type HHMM on UART to set the time (e.g. 0101 = 1:01)",0
s_ok:    DC.B " OK",13,10,0
s_ng:    DC.B " ?",13,10,0
