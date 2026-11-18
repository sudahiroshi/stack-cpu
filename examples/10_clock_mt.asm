; 10_clock_mt.asm — 3つのスレッドで動くアナログ時計とデジタル時計（09_clock.asm を、スレッドに分けたもの）
;
; 動かし方：OSイメージとして、ブートROMから起動する（tid 0、特権モード）。他のスレッドはブートROMの idle で待っている。
;   シミュレータでは、速さを「実時間」にして画面のタブを見る。時刻を合わせるときは、UARTのタブの端末をクリックして
;   4桁の数字を打つ（1時1分なら 0101）。ありえない時刻は無視する。数字以外のキーで打ちかけを捨てる。
;
; スレッドの分担：
;   tid 0（カーネル）  時間の制御とUARTの入力。tid 1・2 を START で起動し、1秒ごとと時刻を合わせたときに、
;                     時刻をメッセージ（tag $7001、本文：時・分・秒）で tid 1 と tid 2 に送る
;   tid 1             アナログ時計。文字盤を描き、時刻のメッセージを受け取るたびに針を描き直す
;   tid 2             デジタル時計。画面の左上に、大きな数字で HH:MM を描く（コロンは1秒ごとに点滅）
;   tid 1・2 は特権モードで起動する（テキストVRAMに直接書くため）。描く場所が重ならないので、排他は要らない。
;   UARTを使うのは tid 0 だけ。tid 1・2 は RECV で待つ間は止まっていて、番を使わない。
;
; メッセージ（10章）：アプリどうしで自由に使う tag（$70xx）を使う。
;   TIME（$7001）  本文：時（0〜23）、分（0〜59）、秒（0〜59）。ヘッダ＝送信元tid 0、tag $7001、n＝3
;   tid 1・2 は、ほかのメッセージが届いたら本文を捨てて無視する。
;
; 画面：
;   中央   アナログ時計（横の半径28桁、縦の半径14行。文字が縦長なので、これで円になる）。描き方は 09_clock.asm と同じ
;   左上   デジタル時計。数字1つは3×5文字で、点は「空白の文字に背景色を付けたもの」（フォントにブロックの図柄がないため）
;   最下行 時刻の合わせ方の説明
; 変数はプログラムの中に置き、PCRELで番地を得る（docs/spec.md 13.2節）。変数は使うスレッドを決めてあり、共有しない。
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
TAG_START EQU 1
TAG_TIME  EQU $7001
TIME_HDR  EQU $00700103           ; tid 0 からの TIME（n＝3）のヘッダ
TID_ANA   EQU 1                   ; アナログ時計のスレッド
TID_DIG   EQU 2                   ; デジタル時計のスレッド
HELP_POS  EQU VRAM+(29*COLS+1)*2  ; 説明の位置（29行・1桁）
; アナログ時計
CX        EQU 40                  ; 文字盤の中心（桁）
CY        EQU 14                  ; 同（行）。外周は0〜28行
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
; デジタル時計（1〜5行。数字は1・5・11・15桁から3桁ずつ、コロンは9桁）
DROW      EQU 1
D_ON      EQU $A0                 ; 点の属性（背景を明るい緑に）
D_OFF     EQU $0F                 ; 点のない所（黒地）
DIG_H1    EQU VRAM+(DROW*COLS+1)*2
DIG_H2    EQU VRAM+(DROW*COLS+5)*2
DIG_M1    EQU VRAM+(DROW*COLS+11)*2
DIG_M2    EQU VRAM+(DROW*COLS+15)*2
COLON1    EQU VRAM+((DROW+1)*COLS+9)*2+1   ; コロンの上の点の属性の番地
COLON2    EQU VRAM+((DROW+3)*COLS+9)*2+1   ; 下の点

; ================================================================ tid 0：カーネル（時間の制御とUARTの入力）
start:  BSR   cls
        LEA   s_help,PC
        PUSH  #HELP_POS
        BSR   vputs
        LEA   s_title,PC
        BSR   tputs
        LEA   analog,PC           ; tid 1 を起動する
        PUSHQ #TID_ANA
        BSR   spawn
        LEA   digital,PC          ; tid 2 を起動する
        PUSHQ #TID_DIG
        BSR   spawn
        BSR   restart             ; いまを基準に、1秒後のタイマをかける
        BSR   notify              ; 00:00:00 を知らせる
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
        BSR   notify
        BRA   main

; spawn ( pc tid -- )  D+6 R+1：スレッドを特権モードで起動する（START：UP、PC＋モード、PKREAD、PKWRITE）
spawn:  PSHR                      ; ( pc )     R:( tid )
        PUSHQ #0                  ; ( pc up )  UPは使わない
        EXG
        PUSHQ #1
        OR                        ; ( up pc|1 )  bit0＝1：特権モード
        PUSHQ #0                  ; PKREAD（特権モードでは使わない）
        PUSHQ #0                  ; PKWRITE
        PUSHQ #TAG_START
        PULR                      ; ( up pc pkr pkw tag tid )
        SEND  4
        RTS

; notify ( -- )  D+5 R+1：いまの時刻を tid 1 と tid 2 に送る（TIME）
notify: LD    v_h,PC
        LD    v_m,PC
        LD    v_s,PC
        PUSH  #TAG_TIME
        PUSHQ #TID_ANA
        SEND  3
        LD    v_h,PC
        LD    v_m,PC
        LD    v_s,PC
        PUSH  #TAG_TIME
        PUSHQ #TID_DIG
        SEND  3
        RTS

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
        BSR   notify
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

; vputs ( s a -- )  D+4 R+3：0で終わる文字列を書く（属性はそのまま）
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

; ================================================================ tid 1・2 で共通
; getmsg ( -- h m s )  D+3 R+1：TIME を受け取るまで待つ（ほかのメッセージは本文を捨てる）。変数を使わない
getmsg: RECV                      ; ( hdr )
        PUSH  T
        PUSH  #TIME_HDR
        CMPEQ
        BNZ   gm_ok
        PUSHQ #15
        AND                       ; ( n )
gm_sk:  PUSH  T
        BZ    gm_nx
        RECV
        POP
        ADD   #-1
        BRA   gm_sk
gm_nx:  POP
        BRA   getmsg
gm_ok:  POP
        RECV
        RECV
        RECV                      ; ( h m s )
        RTS

; putc ( c a -- a+2 )  D+3 R+1：文字コードだけを書く（属性はそのまま）。変数を使わない（tid 0 も使う）
putc:   PUSH  T
        PSHR
        STB
        PULR
        ADD   #2
        RTS

; ================================================================ tid 1：アナログ時計
analog: BSR   dial
an_l:   BSR   getmsg              ; ( h m s )
        LEA   a_s,PC
        ST
        LEA   a_m,PC
        ST
        LEA   a_h,PC
        ST                        ; ( )
        BSR   update
        BRA   an_l

; update ( -- )  D+7 R+5：前の針を消し、いまの時刻の針を描く
update: PUSH  #$20                ; 前の針を空白で消す
        PUSHQ #A_BG
        BSR   setch
        LD    a_ps,PC
        PUSH  #L_SEC
        BSR   hand
        LD    a_pm,PC
        PUSH  #L_MIN
        BSR   hand
        LD    a_ph,PC
        PUSH  #L_HOUR
        BSR   hand
        LD    a_s,PC              ; 新しい位置（0〜59）
        LEA   a_ps,PC
        ST
        LD    a_m,PC
        LEA   a_pm,PC
        ST
        LD    a_h,PC              ; 短針：(時 mod 12)×5＋分÷12
        PUSH  T
        PUSH  #12
        CMPLO
        BNZ   up_1
        ADD   #-12
up_1:   PUSHQ #5
        MULU
        POP
        LD    a_m,PC
        PUSH  #12
        DIVU
        EXG
        POP
        ADD
        LEA   a_ph,PC
        ST
        PUSH  #$23                ; 短針 #
        PUSHQ #A_HOUR
        BSR   setch
        LD    a_ph,PC
        PUSH  #L_HOUR
        BSR   hand
        PUSH  #$2A                ; 長針 *
        PUSHQ #A_MIN
        BSR   setch
        LD    a_pm,PC
        PUSH  #L_MIN
        BSR   hand
        PUSH  #$2E                ; 秒針 .（一番上に描く）
        PUSHQ #A_SEC
        BSR   setch
        LD    a_ps,PC
        PUSH  #L_SEC
        BSR   hand
        PUSH  #$4F                ; 中心 O
        PUSHQ #A_BG
        BSR   setch
        PUSHQ #0
        PUSHQ #0
        BSR   cell
        BSR   putv
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

; hand ( p len -- )  D+7 R+5：位置p（0〜59）の向きに、中心から長さlenまでの点を a_ch・a_at で描く
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
setch:  LEA   a_at,PC
        ST
        LEA   a_ch,PC
        ST
        RTS

; putv ( a -- )  D+3 R+1：番地aの文字に a_ch・a_at を書く
putv:   LD    a_ch,PC
        PUSH  N
        STB                       ; ( a )
        LD    a_at,PC
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

; ================================================================ tid 2：デジタル時計
digital:
dg_l:   BSR   getmsg              ; ( h m s )
        PUSHQ #1
        AND                       ; ( h m odd )  コロンは偶数秒に点ける
        BZ    dg_on
        PUSHQ #D_OFF
        BRA   dg_c
dg_on:  PUSH  #D_ON
dg_c:   PUSH  T                   ; ( h m at at )
        PUSH  #COLON1
        STB
        PUSH  #COLON2
        STB                       ; ( h m )
        PUSH  #DIG_M1
        BSR   big2                ; ( h )
        PUSH  #DIG_H1
        BSR   big2                ; ( )
        BRA   dg_l

; big2 ( n a -- )  D+7 R+4：0〜99を大きな数字2つで書く（aは十の位の左上。一の位は4桁右）
big2:   PSHR                      ; ( n )      R:( a )
        PUSH  #10
        DIVU                      ; ( 一の位 十の位 )
        PEEKR
        BSR   bigdig              ; ( 一の位 )
        PULR
        ADD   #4*2
        BSR   bigdig
        RTS

; bigdig ( d a -- )  D+6 R+3：数字dを3×5文字で書く（aは左上の文字の番地）。点は背景色、点のない所は黒地
;   図柄は15bit（bit14が左上、行ごとに左から右へ）。文字コードは cls の空白のまま、属性だけを書く
bigdig: EXG
        PUSHQ #2
        LSL
        LEA   t_big,PC
        ADD
        LD
        EXG                       ; ( f a )
        PUSHQ #5
        PSHR                      ; R:( 行 )
bd_r:   PUSHQ #3
        PSHR                      ; R:( 行 桁 )
bd_c:   PUSH  N
        PUSH  #$4000
        AND                       ; ( f a 点 )
        BZ    bd_off
        PUSH  #D_ON
        BRA   bd_put
bd_off: PUSHQ #D_OFF
bd_put: PUSH  N
        ADD   #1
        STB                       ; ( f a )    属性
        ADD   #2
        EXG
        PUSHQ #1
        LSL
        EXG                       ; ( f<<1 a+2 )
        PULR
        ADD   #-1
        PUSH  T
        PSHR
        BNZ   bd_c
        PULR
        POP                       ; R:( 行 )
        ADD   #COLS*2-3*2         ; ( f 次の行の左端 )
        PULR
        ADD   #-1
        PUSH  T
        PSHR
        BNZ   bd_r
        PULR
        POP
        POP
        POP
        RTS

; ================================================================ 変数・表・文字列
; tid 0 が使う
v_h:     DC.L 0                   ; 時（0〜23）
v_m:     DC.L 0                   ; 分（0〜59）
v_s:     DC.L 0                   ; 秒（0〜59）
v_dlo:   DC.L 0                   ; 次に1秒進める時刻（下位）
v_dhi:   DC.L 0                   ; 同（上位）
v_val:   DC.L 0                   ; 入力中の数字
v_cnt:   DC.L 0                   ; 入力した桁数
; tid 1 が使う
a_h:     DC.L 0                   ; 受け取った時刻
a_m:     DC.L 0
a_s:     DC.L 0
a_ph:    DC.L 0                   ; いま描いている短針の位置（0〜59）
a_pm:    DC.L 0                   ; 長針の位置
a_ps:    DC.L 0                   ; 秒針の位置
a_ch:    DC.L 0                   ; putv で書く文字
a_at:    DC.L 0                   ; putv で書く属性
; sin(p×6度)×256（p＝0〜59）
t_sin:   DC.L 0,27,53,79,104,128,150,171,190,207
         DC.L 222,234,243,250,255,256,255,250,243,234
         DC.L 222,207,190,171,150,128,104,79,53,27
         DC.L 0,-27,-53,-79,-104,-128,-150,-171,-190,-207
         DC.L -222,-234,-243,-250,-255,-256,-255,-250,-243,-234
         DC.L -222,-207,-190,-171,-150,-128,-104,-79,-53,-27
; 大きな数字の図柄（3×5、0〜9）
t_big:   DC.L $7B6F,$2C97,$73E7,$73CF,$5BC9,$79CF,$79EF,$7249,$7BEF,$7BCF
s_title: DC.B "Analog clock (3 threads): type HHMM to set the time (e.g. 0101 = 1:01)",13,10,0
s_help:  DC.B "Type HHMM on UART to set the time (e.g. 0101 = 1:01)",0
s_ok:    DC.B " OK",13,10,0
s_ng:    DC.B " ?",13,10,0
