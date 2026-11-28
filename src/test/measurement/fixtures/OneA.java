package demo.billing;

import java.math.BigDecimal;
import java.util.List;

/** Card 15A live latency fixture: one top-level class. */
public class InvoiceTotals {
    private final TaxPolicy taxPolicy;

    public InvoiceTotals(TaxPolicy taxPolicy) {
        this.taxPolicy = taxPolicy;
    }

    public BigDecimal total(List<BigDecimal> lines) {
        BigDecimal net = BigDecimal.ZERO;
        for (BigDecimal line : lines) {
            net = net.add(line);
        }
        return net.add(taxPolicy.taxOn(net));
    }
}
