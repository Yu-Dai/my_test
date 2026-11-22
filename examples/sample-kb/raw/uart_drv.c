/* DB1 UART0 driver */
#include "uart_drv.h"

#define REG(off) (*(volatile uint32_t *)(UART0_BASE + (off)))
#define UART_DR  REG(0x00)
#define UART_BRR REG(0x04)
#define UART_SR  REG(0x08)
#define UART_CR  REG(0x0C)

#define SR_TXE  (1u << 0)
#define SR_RXNE (1u << 1)
#define SR_OVR  (1u << 2)
#define SR_FE   (1u << 3)

#define CR_EN   (1u << 0)
#define CR_RXIE (1u << 2)
#define CR_PEN  (1u << 3)
#define CR_STP2 (1u << 4)

#define RX_RING_SIZE 256u

extern void pinmux_set(uint8_t pin, uint8_t func);
extern void irq_enable(uint8_t irq);
extern uint32_t millis(void);

static uint8_t rx_ring[RX_RING_SIZE];
static volatile uint32_t rx_head;
static volatile uint32_t rx_tail;
static volatile uint32_t rx_dropped;

int uart_set_baud(uint32_t baud)
{
    uint32_t div;

    if (baud < 1200u || baud > 921600u) {
        return UART_E_PARAM;
    }
    /* round to nearest: baud = PCLK / (16 * BRR) */
    div = (UART_PCLK_HZ + 8u * baud) / (16u * baud);
    if (div == 0u || div > 0xFFFFu) {
        return UART_E_PARAM;
    }
    UART_CR &= ~CR_EN;      /* BRR may only change while disabled */
    UART_BRR = div;
    return UART_OK;
}

int uart_init(const uart_config_t *cfg)
{
    uint32_t cr = 0;
    int rc;

    if (cfg == NULL || (cfg->stop_bits != 1u && cfg->stop_bits != 2u)) {
        return UART_E_PARAM;
    }
    pinmux_set(9, 1);       /* PA9  -> UART0_TX */
    pinmux_set(10, 1);      /* PA10 -> UART0_RX */

    rc = uart_set_baud(cfg->baud);
    if (rc != UART_OK) {
        return rc;
    }
    if (cfg->parity) {
        cr |= CR_PEN;
    }
    if (cfg->stop_bits == 2u) {
        cr |= CR_STP2;
    }
    if (cfg->use_irq) {
        rx_head = rx_tail = rx_dropped = 0;
        cr |= CR_RXIE;
        irq_enable(5);
    }
    UART_CR = cr;
    UART_CR = cr | CR_EN;   /* enable last */
    return UART_OK;
}

int uart_write(const uint8_t *buf, size_t len)
{
    size_t i;

    for (i = 0; i < len; i++) {
        while ((UART_SR & SR_TXE) == 0u) {
            /* busy wait for FIFO space */
        }
        UART_DR = buf[i];
    }
    return (int)len;
}

int uart_read_polling(uint8_t *buf, size_t len, uint32_t timeout_ms)
{
    uint32_t start = millis();
    size_t n = 0;

    while (n < len) {
        uint32_t sr = UART_SR;

        if (sr & SR_FE) {
            (void)UART_DR;  /* clears the error flags */
            return UART_E_FRAME;
        }
        if (sr & SR_OVR) {
            (void)UART_DR;
            return UART_E_OVERRUN;
        }
        if (sr & SR_RXNE) {
            buf[n++] = (uint8_t)UART_DR;
            continue;
        }
        if (millis() - start >= timeout_ms) {
            return n > 0 ? (int)n : UART_E_TIMEOUT;
        }
    }
    return (int)n;
}

void uart0_irq_handler(void)
{
    /* drain the FIFO completely or the IRQ fires again */
    while (UART_SR & SR_RXNE) {
        uint8_t ch = (uint8_t)UART_DR;
        uint32_t next = (rx_head + 1u) % RX_RING_SIZE;

        if (next == rx_tail) {
            rx_dropped++;   /* ring full, drop the byte */
        } else {
            rx_ring[rx_head] = ch;
            rx_head = next;
        }
    }
}

size_t uart_read_irq(uint8_t *buf, size_t len)
{
    size_t n = 0;

    while (n < len && rx_tail != rx_head) {
        buf[n++] = rx_ring[rx_tail];
        rx_tail = (rx_tail + 1u) % RX_RING_SIZE;
    }
    return n;
}
