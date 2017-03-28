// This is based on public-domain code from
// https://github.com/rcorbish/node-algos.
/**
 * Abstract base for simulated annealing runs
 *
 * This works for fitness functions which are stepwise, made of vertical
 * falloffs and flat horizontal regions, where continuous numerical
 * optimization methods get stuck. It starts off looking far afield for global
 * minima and gradually shifts its focus to the best local one as time
 * progresses.
 *
 * More technically, we look around at random for changes that reduce the value
 * of the cost function. Occasionally, a random change that increases cost is
 * incorporated. The chance of incorporating a cost-increasing change lessens
 * as the algorithim progresses.
 */
class Annealer {
    constructor() {
        this.INITIAL_TEMPERATURE = 5000;
        this.COOLING_STEPS = 5000;
        this.COOLING_FRACTION = 0.95;
        this.STEPS_PER_TEMP = 1000;
        this.BOLTZMANNS = 1.3806485279e-23;
    }

    anneal() {
        let temperature = this.INITIAL_TEMPERATURE;
        let currentSolution = this.initialSolution();
        let currentCost = this.solutionCost(currentSolution);
        let m = 0;
        let n = 0;
        for (let i = 0; i < this.COOLING_STEPS; i++) {
            console.log('Cooling step', i, 'of', this.COOLING_STEPS, '...');
            const startCost = currentCost;
            for (let j = 0; j < this.STEPS_PER_TEMP; j++) {
                let newSolution = this.randomTransition(currentSolution);
                let newCost = this.solutionCost(newSolution);

                if (newCost < currentCost) {
                    currentCost = newCost;
                    currentSolution = newSolution;
                    console.log('New best solution is ', newSolution, ' with fitness ', newCost);
                } else {
                    const minusDelta = currentCost - newCost;
                    const merit = Math.exp(minusDelta / (this.BOLTZMANNS * temperature));
                    if (merit > Math.random()) {
                        m++;
                        currentCost = newCost;
                        currentSolution = newSolution;
                    }
                }
                n++;
                // Exit if we're not moving:
                if (startCost === currentCost) { break; }
            }
            temperature *= this.COOLING_FRACTION;
        }
        console.log('Iterations:', n, 'using', m, 'jumps.');
        return currentSolution;
    }
}

module.exports = {
    Annealer
};
