package demo.orders;

import java.util.ArrayList;
import java.util.List;

/** Card 15A live latency fixture: two classes and an enum. */
enum OrderStatus {
    NEW, PAID, SHIPPED, CANCELLED
}

class Order {
    private final String id;
    private OrderStatus status = OrderStatus.NEW;

    Order(String id) {
        this.id = id;
    }

    String id() {
        return id;
    }

    OrderStatus status() {
        return status;
    }

    void moveTo(OrderStatus next) {
        status = next;
    }
}

class OrderBook {
    private final List<Order> orders = new ArrayList<>();

    void add(Order order) {
        orders.add(order);
    }

    long count(OrderStatus status) {
        return orders.stream().filter(o -> o.status() == status).count();
    }
}
