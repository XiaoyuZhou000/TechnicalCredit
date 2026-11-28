package demo.storage;

import java.util.Optional;

/** Card 15A live latency fixture: one top-level interface. */
public interface DocumentStore {
    /** Saves the document and returns its id. */
    String save(String name, byte[] content);

    Optional<byte[]> load(String id);

    boolean delete(String id);

    default boolean exists(String id) {
        return load(id).isPresent();
    }
}
