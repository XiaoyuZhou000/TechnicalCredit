package demo.notify;

/** Card 15A live latency fixture: a class and an interface. */
interface Channel {
    void send(String recipient, String message);
}

class Notifier {
    private final Channel channel;
    private final int maxRetries;

    Notifier(Channel channel, int maxRetries) {
        this.channel = channel;
        this.maxRetries = maxRetries;
    }

    boolean notify(String recipient, String message) {
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                channel.send(recipient, message);
                return true;
            } catch (RuntimeException e) {
                // Try again until the retries run out.
            }
        }
        return false;
    }
}
