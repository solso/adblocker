# Comparison With Other Blockers

These micro-benchmarks compare different content-blockers network-filter
matching engines.

## Running Benchmarks

1. Get the dataset of [requests](https://cdn.cliqz.com/adblocking/requests_200k.json.gz)
2. Make sure you have setup this project, at the root of the repository run:
```sh
$ npm ci
$ npm pack
```
3. Run the benchmarks from `./bench/comparison`:
```sh
$ make deps
$ make run
```

## Results Analysis

Setup your Python environment:
```sh
$ pip install -r requirements.txt
$ jupyter notebook
```

Then open `comparing_adblockers.ipynb`
