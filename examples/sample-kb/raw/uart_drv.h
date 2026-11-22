/* DB1 UART0 driver - public interface */
#ifndef UART_DRV_H
#define UART_DRV_H

#include <stddef.h>
#include <stdint.h>

#define UART0_BASE   0x40001000u
#define UART_PCLK_HZ 48000000u

/* Error codes, see error-codes.csv */
#define UART_OK          0
#define UART_E_PARAM    -1
#define UART_E_TIMEOUT  -2
#define UART_E_OVERRUN  -3
#define UART_E_FRAME    -4

typedef struct {
    uint32_t baud;       /* 1200 .. 921600 */
    uint8_t  parity;     /* 0 = none, 1 = enabled */
    uint8_t  stop_bits;  /* 1 or 2 */
    uint8_t  use_irq;    /* 0 = polling, 1 = interrupt driven RX */
} uart_config_t;

int uart_init(const uart_config_t *cfg);
int uart_set_baud(uint32_t baud);
int uart_write(const uint8_t *buf, size_t len);
int uart_read_polling(uint8_t *buf, size_t len, uint32_t timeout_ms);
size_t uart_read_irq(uint8_t *buf, size_t len);
void uart0_irq_handler(void);

#endif /* UART_DRV_H */
