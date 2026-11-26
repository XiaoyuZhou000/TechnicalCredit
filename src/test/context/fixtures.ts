import * as fs from 'fs';
import * as path from 'path';

/**
 * Java sources shared by the card 12 tests: the two non-empty prototype fixtures plus short
 * inline sources. Changing one changes the manual-context snapshots, which is the point.
 */

const PROTOTYPE = path.join(__dirname, '..', 'creational', 'prototype');

export const FIXTURES: readonly (readonly [string, string])[] = [
  [
    'Positive.java',
    fs.readFileSync(path.join(PROTOTYPE, 'Positive.java'), 'utf8'),
  ],
  [
    'Negative.java',
    fs.readFileSync(path.join(PROTOTYPE, 'Negative.java'), 'utf8'),
  ],
  [
    'class with annotation, extends and implements',
    [
      'package com.example.app;',
      '',
      'import java.util.List;',
      'import com.example.base.Base;',
      '',
      '/** A documented service. */',
      '@Deprecated',
      'public class A extends Base implements Runnable {',
      '  private final List<String> names;',
      '',
      '  public A(List<String> names) {',
      '    this.names = names;',
      '  }',
      '',
      '  public void run() {}',
      '}',
    ].join('\n'),
  ],
  [
    'interface extending another',
    [
      'import java.io.Closeable;',
      '',
      'interface Port extends Closeable {',
      '  int LIMIT = 3;',
      '  void open();',
      '}',
    ].join('\n'),
  ],
  [
    'class with nested types',
    [
      'class Outer {',
      '  class Inner {',
      '    void work() {}',
      '  }',
      '',
      '  static interface Nested {}',
      '',
      '  enum Mode { ON, OFF }',
      '}',
    ].join('\n'),
  ],
  [
    'top-level enum',
    [
      'enum Level implements Comparable<Level> {',
      '  LOW(1), HIGH(2);',
      '',
      '  private final int weight;',
      '',
      '  Level(int weight) { this.weight = weight; }',
      '',
      '  int weight() { return weight; }',
      '}',
    ].join('\n'),
  ],
  [
    'broken file',
    ['class Fine { void ok() {} }', 'class Broken {', '  void half() {'].join(
      '\n',
    ),
  ],
  ['empty file', ''],
];
