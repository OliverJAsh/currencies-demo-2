import { bind, Subscribe } from "@react-rxjs/core"
import { createKeyedSignal, createSignal, combineKeys } from "@react-rxjs/utils"
import { memo } from "react"
import {
  combineLatest,
  concat,
  defer,
  EMPTY,
  merge,
  Observable,
  of,
  OperatorFunction,
  pipe,
} from "rxjs"
import {
  connect,
  delay,
  defaultIfEmpty,
  distinctUntilChanged,
  filter,
  map,
  mergeMap,
  pluck,
  repeat,
  scan,
  startWith,
  switchMap,
  take,
  takeLast,
  takeUntil,
  takeWhile,
  withLatestFrom,
} from "rxjs/operators"
import {
  initialCurrencyRates,
  formatCurrency,
  NumberInput,
  formatPrice,
  initialOrders,
  Table,
  getBaseCurrencyPrice,
  uuidv4,
  getRandomOrder,
  isCurrecyRateValid,
} from "./utils"

const [useCurrencies] = bind(EMPTY, Object.keys(initialCurrencyRates))

const [rateChange$, onRateChange] = createKeyedSignal<string, number>()
export { onRateChange }

const [cancelRateRequest$, onCancelRateRequest] = createKeyedSignal<string>()

export enum CurrencyRateState {
  ACCEPTED,
  DIRTY,
  IN_PROGRESS,
}

interface CurrencyRate {
  value: number
  state: CurrencyRateState
}

export const [useCurrencyRate, currencyRate$] = bind(
  (currency: string): Observable<CurrencyRate> => {
    const latestAcceptedValue$ = acceptedCurrencyRates$(currency).pipe(take(1))

    const getNextAcceptedValue$ = (candidate: number) =>
      defer(() => isCurrecyRateValid(currency, candidate)).pipe(
        takeUntil(cancelRateRequest$(currency)),
        defaultIfEmpty(false),
        mergeMap((isOk) => (isOk ? of(candidate) : latestAcceptedValue$)),
        map((value) => ({
          value,
          state: CurrencyRateState.ACCEPTED,
        })),
        startWith({ value: candidate, state: CurrencyRateState.IN_PROGRESS }),
      )

    const delayServerValidation = (): OperatorFunction<number, CurrencyRate> =>
      pipe(
        withLatestFrom(latestAcceptedValue$),
        switchMap(([value, latestAccepted]) =>
          value === latestAccepted
            ? of({ value, state: CurrencyRateState.ACCEPTED })
            : concat(
                of({ value, state: CurrencyRateState.DIRTY }),
                of(null).pipe(delay(500)),
              ),
        ),
        takeWhile((x): x is CurrencyRate => !!x),
      )

    const validateRateCurrency = (): OperatorFunction<
      CurrencyRate,
      CurrencyRate
    > =>
      connect((source$) =>
        merge(
          source$,
          source$.pipe(
            takeLast(1),
            mergeMap(({ value }) => getNextAcceptedValue$(value)),
          ),
        ),
      )

    return rateChange$(currency).pipe(
      delayServerValidation(),
      validateRateCurrency(),
      repeat(),
    )
  },
  (currency) => ({
    state: CurrencyRateState.ACCEPTED,
    value: initialCurrencyRates[currency],
  }),
)

const [, acceptedCurrencyRates$] = bind(
  pipe(
    currencyRate$,
    filter(({ state }) => state === CurrencyRateState.ACCEPTED),
    pluck("value"),
    distinctUntilChanged(),
  ),
)

const initialOrderIds = Object.keys(initialOrders)
const [addOrder$, onAddOrder] = createSignal()
const [useOrderIds, orderIds$] = bind(
  addOrder$.pipe(
    map(uuidv4),
    scan((acc, id) => [...acc, id], initialOrderIds),
  ),
  initialOrderIds,
)

const [priceChange$, onPriceChange] = createKeyedSignal<string, number>()
const [currencyChange$, onCurrencyChange] = createKeyedSignal<string, string>()

const [useOrder, order$] = bind((id: string) => {
  const initialOrder = initialOrders[id] || getRandomOrder(id)
  const price$ = concat([initialOrder.price], priceChange$(id))
  const currency$ = concat([initialOrder.currency], currencyChange$(id))

  const rate$ = currency$.pipe(switchMap((ccy) => acceptedCurrencyRates$(ccy)))
  const baseCurrencyPrice$ = combineLatest([price$, rate$]).pipe(
    map(([price, rate]) => getBaseCurrencyPrice(price, rate)),
  )

  return combineLatest({
    price: price$,
    currency: currency$,
    baseCurrencyPrice: baseCurrencyPrice$,
  }).pipe(map((update) => ({ ...initialOrder, ...update })))
})

const [useTotal] = bind(
  combineKeys(orderIds$, pipe(order$, pluck("baseCurrencyPrice"))).pipe(
    map((prices) => Array.from(prices.values()).reduce((a, b) => a + b, 0)),
  ),
)

const CurrencyRateRow: React.FC<{ currency: string }> = ({ currency }) => {
  const currencyRate = useCurrencyRate(currency)
  return (
    <tr key={currency}>
      <td>{formatCurrency(currency)}</td>
      <td
        onClick={() => {
          onCancelRateRequest(currency)
        }}
      >
        <NumberInput
          value={currencyRate.value}
          onChange={(value) => {
            onRateChange(currency, value)
          }}
          style={{
            backgroundColor:
              currencyRate.state === CurrencyRateState.ACCEPTED
                ? "limegreen"
                : undefined,
          }}
          disabled={currencyRate.state === CurrencyRateState.IN_PROGRESS}
        />
      </td>
    </tr>
  )
}

const Currencies = () => {
  const currencies = useCurrencies()
  return (
    <Table columns={["Currency", "Exchange rate"]}>
      {currencies.map((currency) => (
        <CurrencyRateRow key={currency} currency={currency} />
      ))}
    </Table>
  )
}

const CurrencySelector: React.FC<{
  value: string
  onChange: (next: string) => void
}> = ({ value, onChange }) => {
  const currencies = useCurrencies()
  return (
    <select
      onChange={(e) => {
        onChange(e.target.value)
      }}
      value={value}
    >
      {currencies.map((c) => (
        <option key={c} value={c}>
          {formatCurrency(c)}
        </option>
      ))}
    </select>
  )
}

const Orderline: React.FC<{ id: string }> = memo(({ id }) => {
  const order = useOrder(id)
  return (
    <tr>
      <td>{order.title}</td>
      <td>
        <NumberInput
          value={order.price}
          onChange={(value) => {
            onPriceChange(id, value)
          }}
        />
      </td>
      <td>
        <CurrencySelector
          value={order.currency}
          onChange={(value) => {
            onCurrencyChange(id, value)
          }}
        />
      </td>
      <td>{formatPrice(order.baseCurrencyPrice)}£</td>
    </tr>
  )
})

const Orders = () => {
  const orderIds = useOrderIds()
  return (
    <Table columns={["Article", "Price", "Currency", "Price in £"]}>
      {orderIds.map((id) => (
        <Orderline key={id} id={id} />
      ))}
    </Table>
  )
}

const OrderTotal = () => {
  const total = useTotal()
  return <div className="total">{formatPrice(total)}£</div>
}

const App = () => (
  <Subscribe>
    <div className="App">
      <h1>Orders</h1>
      <Orders />
      <div className="actions">
        <button onClick={onAddOrder}>Add</button>
        <OrderTotal />
      </div>
      <h1>Exchange rates</h1>
      <Currencies />
    </div>
  </Subscribe>
)

export default App
