// I/Oレジスタのオフセット（docs/spec.md 12.6節・12.7節）。各デバイスの実装は段階5で行う。

export const UART_REG = { DATA: 0x00, STATUS: 0x04, DIV: 0x08 };
export const UART_STATUS = { RXAVAIL: 1 << 0, TXFULL: 1 << 1, TXEMPTY: 1 << 2, RXOVERRUN: 1 << 3 };
export const UART_FIFO_DEPTH = 16;

export const TIMER_REG = {
  CNT_LO: 0x000, CNT_HI: 0x004, PRESCALE: 0x008,
  CMP_BASE: 0x800, // CMP_LO[tid] = CMP_BASE + tid*8、CMP_HI[tid] = +4
};

export const GPIO_REG = { JOY: 0x00, LED: 0x04 };
export const JOY_BIT = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, SELECT: 6, START: 7 };

export const VIDEO_REG = {
  VIDCAPS: 0x00, VIDMODE: 0x04, CTRL: 0x08, STATUS: 0x0C,
  CURSOR: 0x10, CURSORCTL: 0x14, SCROLL: 0x18, PALETTE: 0x40, // PALETTE[i] = 0x40 + i*4
};
export const TEXT = { COLS: 80, ROWS: 30, CELL_W: 8, CELL_H: 16 };

export const THREAD_REG = { THREADCTL: 0x000, THREADSTAT: 0x100 }; // THREADSTAT[tid] = 0x100 + tid*4
export const THREAD_STATE = {
  RESET: 0, RUNNING: 1, WAIT: 2, RECV: 3, SEND: 4, PARKED: 5, HALT: 6, DOUBLE_FAULT: 7,
};

export const KEYTABLE = { EXTRAM: 0x0000, LOCAL: 0x1000, LOCAL_STRIDE: 0x100 };
export const KEY_ENTRY = { KEY_MASK: 0x1f, W: 1 << 5, X: 1 << 6 };

export const USERPAGE_REG = { CNT_LO: 0x000, CNT_HI: 0x004, CMP_LO: 0x008, CMP_HI: 0x00C, JOY: 0x010 };
