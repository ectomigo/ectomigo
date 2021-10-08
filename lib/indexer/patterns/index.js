'use strict';

import indexPojo from './pojo.js';
import indexMassive from './massive.js';

export default function indexPattern(type) {
  switch (type) {
    case 'pojo': return indexPojo;
    case 'massive': return indexMassive;

    default: throw new Error(`No pattern indexer of type ${type}`);
  }
}
